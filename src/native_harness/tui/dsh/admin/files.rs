//! Explicit local file imports and binary gateway responses.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
const MAX_FILE: usize = 12 * 1024 * 1024;

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
/// The marker must occupy the entire value; it is an explicit user-selected
/// local attachment, never a model-generated tool request. Relative paths use cwd.
pub(super) fn expand_files(mut value: Value, workspace: &Path) -> Result<Value> {
    fn visit(value: &mut Value, workspace: &Path, total: &mut usize) -> Result<()> {
        match value {
            Value::Object(object) if object.contains_key("$file") => {
                if object.len() != 1 {
                    bail!("$fileにはpath以外の項目を指定できません")
                }
                let path = object["$file"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .context("$fileはpath文字列を指定してください")?;
                let path = workspace.join(path);
                let mut options = OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                let file = options.open(&path).map_err(|_| {
                    anyhow::anyhow!(
                        "添付ファイルを開けません（symlink・アクセス権・パスを確認してください）"
                    )
                })?;
                let meta = file
                    .metadata()
                    .context("添付ファイルの状態を取得できません")?;
                if !meta.is_file() || meta.len() > MAX_FILE as u64 {
                    bail!("添付は12MiB以内の通常ファイルを指定してください")
                }
                let mut bytes = Vec::new();
                file.take(MAX_FILE as u64 + 1)
                    .read_to_end(&mut bytes)
                    .context("添付ファイルを読み取れません")?;
                *total += bytes.len();
                if *total > MAX_FILE {
                    bail!("添付の合計サイズは12MiB以内にしてください")
                }
                *value = json!(base64(&bytes));
            }
            Value::Object(object) => {
                for v in object.values_mut() {
                    visit(v, workspace, total)?
                }
            }
            Value::Array(array) => {
                for v in array {
                    visit(v, workspace, total)?
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(&mut value, workspace, &mut 0)?;
    Ok(value)
}

pub(super) fn artifact(bytes: &[u8], media_type: &str) -> Result<Value> {
    let root = std::env::temp_dir().join(format!(
        "rdsh-tui-artifact-{}",
        crate::local_http::random_token()?
    ));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&root)
        .context("管理出力フォルダを作成できません")?;
    let path = root.join("response.bin");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| {
        let mut file = options.open(&path)?;
        file.write_all(bytes)?;
        file.flush()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&root);
        bail!("管理出力ファイルを保存できません")
    }
    Ok(json!({"$artifact":path,"bytes":bytes.len(),"mediaType":media_type}))
}

fn position(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
fn boundary(content_type: &str) -> Result<String> {
    let value = content_type
        .split(';')
        .skip(1)
        .find_map(|v| v.trim().strip_prefix("boundary="))
        .context("multipart boundaryがありません")?;
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    if value.is_empty()
        || value.len() > 200
        || !value.bytes().all(|b| b.is_ascii_graphic() && b != b'"')
    {
        bail!("multipart boundaryが不正です")
    }
    Ok(value.to_owned())
}
fn part_name(headers: &str) -> Result<String> {
    let disposition = headers
        .split("\r\n")
        .find_map(|line| {
            line.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-disposition"))
                .map(|(_, v)| v)
        })
        .context("multipart dispositionがありません")?;
    let name = disposition
        .split(';')
        .skip(1)
        .find_map(|field| {
            field
                .trim()
                .strip_prefix("name=\"")
                .and_then(|s| s.strip_suffix('"'))
        })
        .context("multipart part名がありません")?;
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        bail!("multipart part名が不正です")
    }
    Ok(name.into())
}
/// Decode the public gateway's FormData response: `metadata` JSON and named
/// byte parts. Restore attachment placeholders with local artifact descriptors.
pub(super) fn decode_multipart(content_type: &str, bytes: &[u8]) -> Result<Value> {
    let boundary = boundary(content_type)?;
    let start = format!("--{boundary}\r\n");
    let separator = format!("\r\n--{boundary}");
    if !bytes.starts_with(start.as_bytes()) {
        bail!("multipart先頭が不正です")
    }
    let mut remaining = &bytes[start.len()..];
    let mut parts = BTreeMap::<String, &[u8]>::new();
    loop {
        if parts.len() > 128 {
            bail!("multipart partsが上限を超えました")
        }
        let h = position(remaining, b"\r\n\r\n")
            .filter(|h| *h <= 16384)
            .context("multipart headerが不正です")?;
        let headers = std::str::from_utf8(&remaining[..h])
            .context("multipart headerがUTF-8ではありません")?;
        let name = part_name(headers)?;
        let data = &remaining[h + 4..];
        let end = position(data, separator.as_bytes()).context("multipart終端がありません")?;
        if parts.insert(name, &data[..end]).is_some() {
            bail!("multipartに重複partがあります")
        }
        remaining = &data[end + separator.len()..];
        if remaining.starts_with(b"--") {
            break;
        }
        if !remaining.starts_with(b"\r\n") {
            bail!("multipart区切りが不正です")
        }
        remaining = &remaining[2..];
    }
    let metadata = parts
        .remove("metadata")
        .context("multipart metadataがありません")?;
    let mut value: Value =
        serde_json::from_slice(metadata).context("multipart metadata JSONが不正です")?;
    let attachments = value["attachments"]
        .as_array()
        .context("multipart attachmentsがありません")?
        .clone();
    if attachments.len() != parts.len() {
        bail!("multipart attachment件数が一致しません")
    }
    // Validate every placeholder before writing any file.
    let mut seen = std::collections::HashSet::new();
    let mut paths = std::collections::HashSet::new();
    for attachment in &attachments {
        let part = attachment["part"]
            .as_str()
            .context("attachment partがありません")?;
        if attachment["codec"] != "bytes"
            || !seen.insert(part)
            || !parts.contains_key(part)
            || !paths.insert(attachment["path"].to_string())
        {
            bail!("attachment codec/partが不正です")
        }
        let target = attachment_target(&mut value["result"]["value"], &attachment["path"])?;
        if !target.is_null() {
            bail!("attachment placeholderが不正です")
        }
    }
    for attachment in attachments {
        let part = attachment["part"].as_str().unwrap();
        let output = artifact(parts[part], "application/octet-stream")?;
        *attachment_target(&mut value["result"]["value"], &attachment["path"])? = output;
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("attachments");
    }
    Ok(value)
}
fn attachment_target<'a>(mut value: &'a mut Value, path: &Value) -> Result<&'a mut Value> {
    let path = path.as_array().context("attachment pathが不正です")?;
    if path.len() > 128 {
        bail!("attachment pathが長すぎます")
    }
    for segment in path {
        value = if let Some(key) = segment.as_str() {
            value.as_object_mut().and_then(|o| o.get_mut(key))
        } else if let Some(index) = segment.as_u64() {
            usize::try_from(index)
                .ok()
                .and_then(|i| value.as_array_mut().and_then(|a| a.get_mut(i)))
        } else {
            None
        }
        .context("attachment pathがresultに存在しません")?;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64_has_canonical_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0, 255, 128]), "AP+A");
    }
    #[test]
    fn multipart_restores_exact_binary_and_private_file() {
        let metadata=json!({"type":"server-response","rpcId":"test","result":{"ok":true,"value":{"body":null}},"attachments":[{"path":["body"],"codec":"bytes","part":"bytes-0"}]}).to_string();
        let mut data=format!("--abc\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{metadata}\r\n--abc\r\nContent-Disposition: form-data; name=\"bytes-0\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        data.extend_from_slice(&[0, 255, 13, 10, 128]);
        data.extend_from_slice(b"\r\n--abc--\r\n");
        let value = decode_multipart("multipart/form-data; boundary=abc", &data).unwrap();
        let path = Path::new(
            value["result"]["value"]["body"]["$artifact"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(fs::read(path).unwrap(), [0, 255, 13, 10, 128]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
        assert!(decode_multipart("multipart/form-data; boundary=abc", b"bad").is_err());
    }
    #[test]
    fn import_file_is_explicit_and_rejects_symlink() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-admin-test-{}",
            crate::local_http::random_token().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("data"), b"hello").unwrap();
        assert_eq!(
            expand_files(json!({"request":{"data":{"$file":"data"}}}), &root).unwrap()["request"]
                ["data"],
            "aGVsbG8="
        );
        assert!(expand_files(json!({"$file":"data","extra":true}), &root).is_err());
        assert!(expand_files(json!({"$file":"."}), &root).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("data"), root.join("link")).unwrap();
            assert!(expand_files(json!({"$file":"link"}), &root).is_err());
            fs::remove_file(root.join("link")).unwrap();
        }
        fs::remove_file(root.join("data")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
