//! プロバイダに依らない Native Compaction の、共有する部分。
//!
//! このクレートは通信をしない。
//! 持つのは、しきい値の計算、切れ目の選び方、元が取れるかの計算、
//! 要約の指示の検査、接続先ごとの対応表、記録の形。

pub mod capability;
pub mod cost;
pub mod cut;
pub mod instructions;
pub mod provider;
pub mod record;
pub mod threshold;

pub use capability::*;
pub use cost::*;
pub use cut::*;
pub use instructions::*;
pub use record::*;
pub use threshold::*;
