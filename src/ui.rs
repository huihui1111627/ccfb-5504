//! Embedded management UI assets. A single-page app with no build step and no
//! external CDN dependencies — exam networks are often air-gapped.

pub fn asset(rel: &str) -> Option<&'static [u8]> {
    match rel {
        "index.html" => Some(include_bytes!("../assets/index.html")),
        "app.js" => Some(include_bytes!("../assets/app.js")),
        "styles.css" => Some(include_bytes!("../assets/styles.css")),
        _ => None,
    }
}
