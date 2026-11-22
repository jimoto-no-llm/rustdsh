// Format only rdsh-owned presentation text; supplied values keep their bytes.
macro_rules! localized_format {
    ($locale:expr, $english:literal, $chinese:literal, $japanese:literal $(, $value:expr)* $(,)?) => {
        match $locale {
            crate::locale::Locale::English => format!($english $(, $value)*),
            crate::locale::Locale::Chinese => format!($chinese $(, $value)*),
            crate::locale::Locale::Japanese => format!($japanese $(, $value)*),
        }
    };
}
