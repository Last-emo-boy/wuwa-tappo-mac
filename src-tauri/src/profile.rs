use serde_json::json;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    Cn,
    Global,
}

impl Region {
    pub fn from_identifier(identifier: &str) -> Result<Self, String> {
        match identifier {
            "dev.w33d.wuwatappo.cn.mac" => Ok(Self::Cn),
            "dev.w33d.wuwatappo.global.mac" => Ok(Self::Global),
            _ => Err("Unknown Wuwa Tappo application identity".into()),
        }
    }

    pub fn from_app(app: &AppHandle) -> Self {
        *app.state::<Self>()
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Cn => "Wuwa Tappo CN Mac",
            Self::Global => "Wuwa Tappo Global Mac",
        }
    }

    pub fn api_host(self) -> &'static str {
        match self {
            Self::Cn => "api-mc-wuwatappo.kurogames-global.com",
            Self::Global => "api-wutheringwaves-wuwatappo.kurogames-global.com",
        }
    }

    pub fn asset_host(self) -> &'static str {
        match self {
            Self::Cn => "mc-wuwatappo.kurogames-global.com",
            Self::Global => "wutheringwaves-wuwatappo.kurogames-global.com",
        }
    }

    pub fn initialization_script(self) -> String {
        let profile = json!({
            "region": if self == Self::Cn { "CN" } else { "GLOBAL" },
            "productName": self.name(),
            "socketHost": self.api_host(),
        });
        format!("Object.defineProperty(window,'__WUWATAPPO_PROFILE__',{{value:Object.freeze({profile}),writable:false,configurable:false}});")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_app_identities_select_a_region() {
        assert_eq!(
            Region::from_identifier("dev.w33d.wuwatappo.cn.mac"),
            Ok(Region::Cn)
        );
        assert_eq!(
            Region::from_identifier("dev.w33d.wuwatappo.global.mac"),
            Ok(Region::Global)
        );
        assert!(Region::from_identifier("dev.w33d.wuwatappo.mac").is_err());
        assert!(Region::from_identifier("global").is_err());
        assert_ne!(Region::Cn.api_host(), Region::Global.api_host());
        assert_ne!(Region::Cn.asset_host(), Region::Global.asset_host());
    }

    #[test]
    fn native_profiles_inject_the_matching_immutable_webview_identity() {
        for region in [Region::Cn, Region::Global] {
            let script = region.initialization_script();
            assert!(script.contains(region.name()));
            assert!(script.contains(region.api_host()));
            assert!(script.contains("Object.freeze"));
            assert!(script.contains("configurable:false"));
        }
    }

    #[test]
    fn app_configurations_keep_independent_data_identities_and_global_only_callback_registration() {
        let cn: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let global: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.global.conf.json")).unwrap();
        for (config, region) in [(cn, Region::Cn), (global.clone(), Region::Global)] {
            assert_eq!(
                Region::from_identifier(config["identifier"].as_str().unwrap()).unwrap(),
                region
            );
            assert_eq!(config["productName"], region.name());
        }
        assert!(!include_str!("../Info.plist").contains("wuwa-buddy"));
        assert!(include_str!("../Info.global.plist").contains("<string>wuwa-buddy</string>"));
        let capability = &global["app"]["security"]["capabilities"][1];
        assert_eq!(capability["windows"], json!(["main"]));
        assert_eq!(
            capability["permissions"],
            json!(["deep-link:allow-get-current"])
        );
    }
}
