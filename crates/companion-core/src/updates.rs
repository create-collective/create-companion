//! Update checks: where the release manifest lives, how often to look, and how
//! two version numbers compare. The engine does the weekly check (when the user
//! said yes to it) and the configuration window installs, through Tauri's
//! updater, from the same manifest.

/// The manifest the release workflow attaches to every release (`latest.json`).
/// GitHub resolves `releases/latest` to the newest published release.
pub const MANIFEST_URL: &str =
    "https://github.com/create-collective/create-companion/releases/latest/download/latest.json";

/// Points the engine and the window at another manifest. The updater test
/// serves one on localhost; nothing else sets it.
pub const MANIFEST_URL_ENV: &str = "CREATE_COMPANION_UPDATE_URL";

pub fn manifest_url() -> String {
    std::env::var(MANIFEST_URL_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| MANIFEST_URL.to_string())
}

/// A week between automatic checks.
pub const CHECK_INTERVAL_SECS: u64 = 7 * 24 * 60 * 60;

/// An automatic check is due when there never was one, a week has passed, or
/// the clock went backwards since the last.
pub fn check_due(last_check: Option<u64>, now: u64) -> bool {
    match last_check {
        None => true,
        Some(t) => now < t || now - t >= CHECK_INTERVAL_SECS,
    }
}

/// `candidate` is a later release than `current`. Versions are `major.minor.patch`,
/// with or without a leading `v`; a pre-release (`1.0.0-beta.1`) sorts before
/// its release. Anything that does not parse is never newer.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (Version::parse(candidate), Version::parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Field order is the comparison order: a release (`release: true`) sorts after
/// any pre-release of the same numbers.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    release: bool,
    pre: String,
}

impl Version {
    fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
        let s = s.split('+').next()?; // build metadata never orders
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p),
            None => (s, ""),
        };
        let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
        let (major, minor, patch) = (parts.next()??, parts.next()??, parts.next()??);
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            release: pre.is_empty(),
            pre: pre.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_by_each_part() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.1.0", "1.0.9"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(is_newer("1.10.0", "1.9.0"), "numbers compare as numbers");
    }

    #[test]
    fn not_newer() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.4.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
    }

    #[test]
    fn prefixes_and_metadata() {
        assert!(is_newer("v1.0.1", "1.0.0"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0+build.7", "1.0.0"));
    }

    #[test]
    fn prerelease_sorts_before_its_release() {
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
        assert!(is_newer("1.0.1-beta.1", "1.0.0"));
    }

    #[test]
    fn garbage_is_never_newer() {
        for bad in ["", "latest", "1.0", "1.0.0.0", "1.x.0", "-1.0.0"] {
            assert!(!is_newer(bad, "0.1.0"), "{bad:?}");
            assert!(!is_newer("9.9.9", bad), "current {bad:?}");
        }
    }

    #[test]
    fn weekly_due() {
        let now = 1_800_000_000;
        assert!(check_due(None, now));
        assert!(!check_due(Some(now - 60), now));
        assert!(!check_due(Some(now - CHECK_INTERVAL_SECS + 1), now));
        assert!(check_due(Some(now - CHECK_INTERVAL_SECS), now));
        assert!(check_due(Some(now + 3600), now), "clock moved back");
    }
}
