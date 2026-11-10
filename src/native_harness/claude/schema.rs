//! Generation format only. Rust still validates targets and seeks approval.
use serde_json::{json, Value};

pub(super) fn turn() -> Value {
    let tool = |name: &str, arguments: Value| {
        json!({"type":"object","additionalProperties":false,
            "required":["id","name","arguments"],"properties":{
                "id":{"type":"string","minLength":1,"maxLength":160},
                "name":{"type":"string","const":name},"arguments":arguments}})
    };
    json!({"type":"object","additionalProperties":false,
    "required":["version","text","toolCalls"],"properties":{
        "version":{"type":"integer","const":1},
        "text":{"type":"string","maxLength":131072},
        "toolCalls":{"type":"array","maxItems":8,"items":{"anyOf":[
            tool("read",json!({"type":"object","additionalProperties":false,
                "required":["path"],"properties":{"path":{"type":"string","minLength":1,"maxLength":4096}}})),
            tool("devin_cli",json!({"type":"object","additionalProperties":false,
                "required":["prompt"],"properties":{
                    "prompt":{"type":"string","minLength":1,"maxLength":16384},
                    "timeout":{"type":"integer","minimum":1,"maximum":300}}})),
            tool("model_call",json!({"type":"object","additionalProperties":false,
                "required":["provider","model","prompt"],"properties":{
                    "provider":{"type":"string","minLength":1,"maxLength":200},
                    "model":{"type":"string","minLength":1,"maxLength":200},
                    "prompt":{"type":"string","minLength":1,"maxLength":16384}}}))
        ]}}}})
}
