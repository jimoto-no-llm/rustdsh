//! Provider-reported counters only. Missing or invalid data is never estimated.
use serde::Serialize;
use serde_json::Value;
#[derive(Clone, Debug, Default, Serialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}
#[derive(Debug)]
pub struct Generation {
    pub text: String,
    pub usage: Usage,
}
impl Usage {
    pub fn parse(api: &str, value: &Value) -> Self {
        let u = &value["usage"];
        let mut result = match api {
            "anthropic-messages" => Self {
                input_tokens: u["input_tokens"]
                    .as_u64()
                    .and_then(|n| n.checked_add(u["cache_read_input_tokens"].as_u64()?))
                    .and_then(|n| n.checked_add(u["cache_creation_input_tokens"].as_u64()?)),
                output_tokens: u["output_tokens"].as_u64(),
                cache_read_tokens: u["cache_read_input_tokens"].as_u64(),
                cache_write_tokens: u["cache_creation_input_tokens"].as_u64(),
                reasoning_tokens: None,
            },
            "google-generative-ai" => {
                let u = &value["usageMetadata"];
                Self {
                    input_tokens: u["promptTokenCount"].as_u64(),
                    output_tokens: u["candidatesTokenCount"]
                        .as_u64()
                        .and_then(|n| n.checked_add(u["thoughtsTokenCount"].as_u64().unwrap_or(0))),
                    cache_read_tokens: u["cachedContentTokenCount"].as_u64(),
                    cache_write_tokens: None,
                    reasoning_tokens: u["thoughtsTokenCount"].as_u64(),
                }
            }
            "openai-completions" => Self {
                input_tokens: u["prompt_tokens"].as_u64(),
                output_tokens: u["completion_tokens"].as_u64(),
                cache_read_tokens: u["prompt_tokens_details"]["cached_tokens"].as_u64(),
                cache_write_tokens: u["prompt_tokens_details"]["cache_write_tokens"].as_u64(),
                reasoning_tokens: u["completion_tokens_details"]["reasoning_tokens"].as_u64(),
            },
            "openai-responses" => Self {
                input_tokens: u["input_tokens"].as_u64(),
                output_tokens: u["output_tokens"].as_u64(),
                cache_read_tokens: u["input_tokens_details"]["cached_tokens"].as_u64(),
                cache_write_tokens: u["input_tokens_details"]["cache_write_tokens"].as_u64(),
                reasoning_tokens: u["output_tokens_details"]["reasoning_tokens"].as_u64(),
            },
            _ => Self::default(),
        };
        if matches!((result.cache_read_tokens,result.input_tokens),(Some(read),Some(input)) if read>input)
        {
            result.cache_read_tokens = None;
        }
        result
    }
}
#[derive(Clone, Default, Serialize)]
pub struct UsageStats {
    pub requests: u64,
    pub known_input_requests: u64,
    pub known_output_requests: u64,
    pub known_cache_requests: u64,
    pub known_cache_write_requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_input_tokens: u64,
    pub last: Option<UsageRecord>,
}
#[derive(Clone, Serialize)]
pub struct UsageRecord {
    pub provider: String,
    pub model: String,
    pub usage: Usage,
    pub elapsed_ms: Option<u64>,
}
impl UsageStats {
    pub fn start(&mut self, provider: &str, model: &str) {
        self.requests = self.requests.saturating_add(1);
        self.last = Some(UsageRecord {
            provider: provider.into(),
            model: model.into(),
            usage: Usage::default(),
            elapsed_ms: None,
        });
    }
    pub fn finish(&mut self, usage: &Usage, elapsed_ms: u64) {
        if let Some(v) = usage.input_tokens {
            self.input_tokens = self.input_tokens.saturating_add(v);
            self.known_input_requests = self.known_input_requests.saturating_add(1);
        }
        if let Some(v) = usage.output_tokens {
            self.output_tokens = self.output_tokens.saturating_add(v);
            self.known_output_requests = self.known_output_requests.saturating_add(1);
        }
        if let (Some(input), Some(read)) = (usage.input_tokens, usage.cache_read_tokens) {
            if read <= input {
                self.cache_input_tokens = self.cache_input_tokens.saturating_add(input);
                self.cache_read_tokens = self.cache_read_tokens.saturating_add(read);
                self.known_cache_requests = self.known_cache_requests.saturating_add(1);
            }
        }
        if let Some(tokens) = usage.cache_write_tokens {
            self.cache_write_tokens = self.cache_write_tokens.saturating_add(tokens);
            self.known_cache_write_requests = self.known_cache_write_requests.saturating_add(1);
        }
        if let Some(last) = &mut self.last {
            last.usage = usage.clone();
            last.elapsed_ms = Some(elapsed_ms);
        }
    }
    pub fn snapshot(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("usage counters are serializable");
        value["cache_hit_rate"] = serde_json::json!(self.cache_hit_rate());
        value
    }
    pub fn cache_hit_rate(&self) -> Option<f64> {
        (self.cache_input_tokens > 0)
            .then(|| self.cache_read_tokens as f64 / self.cache_input_tokens as f64 * 100.0)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_counters_are_normalized_without_double_counting_cache_or_reasoning() {
        let u = Usage::parse(
            "anthropic-messages",
            &json!({"usage":{"input_tokens":20,"cache_read_input_tokens":60,"cache_creation_input_tokens":20,"output_tokens":5}}),
        );
        assert_eq!(u.input_tokens, Some(100));
        let u2 = Usage::parse(
            "openai-responses",
            &json!({"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":10}}}),
        );
        assert_eq!(u2.input_tokens, Some(100));
        assert_eq!(u2.output_tokens, Some(20));
        let mut stats = UsageStats::default();
        stats.start("test", "one");
        stats.finish(&u, 1);
        stats.start("test", "two");
        stats.finish(&u2, 2);
        assert_eq!(stats.input_tokens, 200);
        assert_eq!(stats.known_cache_write_requests, 1);
        assert_eq!(stats.cache_hit_rate(), Some(70.0));
        stats.start("sdk", "unknown");
        stats.finish(&Usage::default(), 3);
        assert_eq!(stats.requests, 3);
        assert_eq!(stats.known_input_requests, 2);
        assert_eq!(stats.cache_hit_rate(), Some(70.0));
    }
    #[test]
    fn unavailable_and_invalid_fields_do_not_become_zero_or_fake_cache_hits() {
        assert_eq!(
            Usage::parse("openai-responses", &json!({})).input_tokens,
            None
        );
        let u = Usage::parse(
            "openai-responses",
            &json!({"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":11}}}),
        );
        assert_eq!(u.cache_read_tokens, None);
        assert_eq!(UsageStats::default().cache_hit_rate(), None);
        let u = Usage::parse(
            "google-generative-ai",
            &json!({"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":40,"candidatesTokenCount":9,"thoughtsTokenCount":3}}),
        );
        assert_eq!(u.output_tokens, Some(12));
    }
}
