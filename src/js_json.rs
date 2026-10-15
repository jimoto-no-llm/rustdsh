//! JSON serialization rules used by the JavaScript compatibility boundary.

use serde_json::{Map, Number, Value};

pub fn stringify(value: &Value) -> String {
    let mut output = String::new();
    write_value(value, &mut output);
    output
}

fn write_value(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&number_to_string(value)),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("strings serialize"));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => write_object(values, output),
    }
}

fn write_object(values: &Map<String, Value>, output: &mut String) {
    let mut entries: Vec<_> = values.iter().collect();
    entries.sort_by_key(|(key, _)| {
        let index = array_index(key);
        (index.is_none(), index.unwrap_or_default())
    });
    output.push('{');
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&serde_json::to_string(key).expect("object keys serialize"));
        output.push(':');
        write_value(value, output);
    }
    output.push('}');
}

fn array_index(key: &str) -> Option<u32> {
    let value = key.parse::<u32>().ok()?;
    (value != u32::MAX && value.to_string() == key).then_some(value)
}

fn number_to_string(value: &Number) -> String {
    let number = value
        .as_f64()
        .expect("JSON numbers convert to finite doubles");
    if number == 0.0 {
        return "0".into();
    }

    let raw = serde_json::to_string(&number.abs()).expect("finite doubles serialize");
    let (mantissa, exponent) =
        raw.split_once(['e', 'E'])
            .map_or((raw.as_str(), 0i32), |(mantissa, exponent)| {
                (
                    mantissa,
                    exponent.parse().expect("float exponent is numeric"),
                )
            });
    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = format!("{integer}{fraction}");
    let mut decimal_position = integer.len() as i32 + exponent;
    let leading_zeroes = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading_zeroes);
    decimal_position -= leading_zeroes as i32;
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }

    let magnitude = if decimal_position > 0 && decimal_position <= 21 {
        let position = decimal_position as usize;
        if position >= digits.len() {
            format!("{}{}", digits, "0".repeat(position - digits.len()))
        } else {
            format!("{}.{}", &digits[..position], &digits[position..])
        }
    } else if decimal_position <= 0 && decimal_position > -6 {
        format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
    } else {
        let exponent = decimal_position - 1;
        let significand = if digits.len() == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        if exponent >= 0 {
            format!("{significand}e+{exponent}")
        } else {
            format!("{significand}e{exponent}")
        }
    };

    if number.is_sign_negative() {
        format!("-{magnitude}")
    } else {
        magnitude
    }
}

#[cfg(test)]
mod tests {
    use super::stringify;
    use serde_json::{Number, Value};

    #[test]
    fn numbers_follow_json_stringify_decimal_and_exponent_ranges() {
        let value = serde_json::json!({
            "one": 1.0,
            "cost": 5.0,
            "fixed_small": 1e-6,
            "small": 1e-7,
            "fixed_large": 1e20,
            "large": 1e21,
            "negative_zero": -0.0
        });
        assert_eq!(
            stringify(&value),
            r#"{"one":1,"cost":5,"fixed_small":0.000001,"small":1e-7,"fixed_large":100000000000000000000,"large":1e+21,"negative_zero":0}"#
        );
    }

    #[test]
    fn integer_object_keys_are_emitted_before_other_keys() {
        let value: Value = serde_json::from_str(r#"{"b":1,"2":2,"1":1,"a":0}"#).unwrap();
        assert_eq!(stringify(&value), r#"{"1":1,"2":2,"b":1,"a":0}"#);
    }

    #[test]
    fn parses_json_numbers_to_the_javascript_binary64_value() {
        let value: Value = serde_json::from_str("913420.7214268055").unwrap();
        assert_eq!(value.as_f64().unwrap().to_bits(), 0x412b_e019_715e_dab0);
        assert_eq!(stringify(&value), "913420.7214268055");
    }

    #[test]
    fn formats_binary64_with_the_javascript_shortest_decimal() {
        let number = Number::from_f64(f64::from_bits(0x430c_6bf5_2634_0002)).unwrap();
        assert_eq!(stringify(&Value::Number(number)), "1000000000000000.2");
    }
}
