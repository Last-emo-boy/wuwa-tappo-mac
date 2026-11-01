use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions, NSWorkspace};
use objc2_core_foundation::{CFDictionary, CFNumber, CFString, CFType, CGRect};
use objc2_core_graphics::{
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowOwnerPID, CGDisplayBounds, CGError,
    CGGetActiveDisplayList, CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};

#[derive(Clone, Copy)]
struct WindowMetadata {
    owner_pid: i32,
    alpha: f64,
    bounds: CGRect,
}

pub fn foreground_application_fullscreen() -> Result<bool, String> {
    let mtm = MainThreadMarker::new().ok_or("Screen state must be read on the main thread")?;
    let Some(application) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        return Ok(false);
    };
    let foreground_pid = application.processIdentifier();
    let own_pid = std::process::id();
    // The pet's screen-sized shell must not enable automatic game mode.
    if foreground_pid <= 0 || foreground_pid as u32 == own_pid {
        return Ok(false);
    }
    if NSApplication::sharedApplication(mtm)
        .currentSystemPresentationOptions()
        .contains(NSApplicationPresentationOptions::FullScreen)
    {
        return Ok(true);
    }

    // Only public window metadata is read, not names or window contents.
    let windows = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        kCGNullWindowID,
    )
    .ok_or("Could not read on-screen window metadata")?;
    // Window Services returns dictionaries containing Core Foundation objects.
    let windows = unsafe { windows.cast_unchecked::<CFType>() };
    for value in windows.iter() {
        let dictionary = value
            .downcast_ref::<CFDictionary>()
            .ok_or("Invalid on-screen window metadata dictionary")?;
        // Window-info dictionary keys are CFStrings and values are CF objects.
        let dictionary = unsafe { dictionary.cast_unchecked::<CFString, CFType>() };
        let owner_pid = dictionary
            .get(unsafe { kCGWindowOwnerPID })
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|value| value.as_i32())
            .ok_or("Invalid on-screen window owner PID")?;
        if owner_pid != foreground_pid {
            continue;
        }
        let alpha = dictionary
            .get(unsafe { kCGWindowAlpha })
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|value| value.as_f64())
            .ok_or("Invalid foreground window alpha")?;
        if !alpha.is_finite() || alpha <= 0.0 {
            continue;
        }
        let value = dictionary
            .get(unsafe { kCGWindowBounds })
            .ok_or("Missing foreground window bounds")?;
        let bounds_dictionary = value
            .downcast_ref::<CFDictionary>()
            .ok_or("Invalid foreground window bounds dictionary")?;
        let mut bounds = CGRect::ZERO;
        if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(bounds_dictionary), &mut bounds) }
        {
            return Err("Invalid foreground window bounds".into());
        }
        if !valid_bounds(bounds) {
            continue;
        }
        return Ok(foreground_window_is_fullscreen(
            &[WindowMetadata {
                owner_pid,
                alpha,
                bounds,
            }],
            foreground_pid,
            own_pid,
            &active_display_bounds()?,
        ));
    }
    Ok(false)
}

fn active_display_bounds() -> Result<Vec<CGRect>, String> {
    let mut count = 0;
    let result = unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut count) };
    if result != CGError::Success {
        return Err(format!("Could not count active displays: {result:?}"));
    }
    let mut displays = vec![0; count as usize];
    let result = unsafe { CGGetActiveDisplayList(count, displays.as_mut_ptr(), &mut count) };
    if result != CGError::Success {
        return Err(format!("Could not list active displays: {result:?}"));
    }
    displays.truncate(count as usize);
    Ok(displays
        .into_iter()
        .map(|display| CGDisplayBounds(display))
        .collect())
}

fn valid_bounds(bounds: CGRect) -> bool {
    [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
    ]
    .iter()
    .all(|value| value.is_finite())
        && bounds.size.width > 0.0
        && bounds.size.height > 0.0
}

fn matches_display(window: CGRect, display: CGRect) -> bool {
    if !valid_bounds(window) || !valid_bounds(display) {
        return false;
    }
    let edges = |bounds: CGRect| {
        [
            bounds.origin.x,
            bounds.origin.y,
            bounds.origin.x + bounds.size.width,
            bounds.origin.y + bounds.size.height,
        ]
    };
    // Both APIs use Quartz logical coordinates, including negative origins.
    edges(window)
        .iter()
        .zip(edges(display))
        .all(|(window, display)| (window - display).abs() <= 1.0)
}

fn foreground_window_is_fullscreen(
    windows: &[WindowMetadata],
    foreground_pid: i32,
    own_pid: u32,
    displays: &[CGRect],
) -> bool {
    if foreground_pid <= 0 || foreground_pid as u32 == own_pid {
        return false;
    }
    // On-screen windows arrive front to back. A rear full-size window must not
    // hide a normal foreground window of the same application.
    windows
        .iter()
        .find(|window| {
            window.owner_pid == foreground_pid
                && window.alpha.is_finite()
                && window.alpha > 0.0
                && valid_bounds(window.bounds)
        })
        .is_some_and(|window| {
            displays
                .iter()
                .any(|display| matches_display(window.bounds, *display))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_foundation::{CGPoint, CGSize};

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> CGRect {
        CGRect::new(CGPoint::new(x, y), CGSize::new(width, height))
    }

    fn window(owner_pid: i32, alpha: f64, bounds: CGRect) -> WindowMetadata {
        WindowMetadata {
            owner_pid,
            alpha,
            bounds,
        }
    }

    #[test]
    fn full_display_match_allows_one_logical_unit_at_each_edge() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        assert!(matches_display(display, display));
        assert!(matches_display(bounds(1.0, -1.0, 1510.0, 984.0), display));
        assert!(!matches_display(bounds(2.0, 0.0, 1512.0, 982.0), display));
        assert!(!matches_display(bounds(0.0, 0.0, 1514.0, 982.0), display));
    }

    #[test]
    fn ordinary_maximized_work_area_does_not_match_the_display() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        assert!(!matches_display(bounds(0.0, 37.0, 1512.0, 880.0), display));
        assert!(!matches_display(bounds(50.0, 0.0, 1462.0, 982.0), display));
    }

    #[test]
    fn negative_origins_and_different_display_scales_stay_in_logical_coordinates() {
        let retina = bounds(0.0, 0.0, 1512.0, 982.0);
        let secondary = bounds(-1920.0, -200.0, 1920.0, 1080.0);
        assert!(foreground_window_is_fullscreen(
            &[window(42, 1.0, secondary)],
            42,
            7,
            &[retina, secondary],
        ));
        assert!(!matches_display(bounds(0.0, 0.0, 3024.0, 1964.0), retina));
        assert!(!matches_display(
            bounds(0.0, -200.0, 1920.0, 1080.0),
            secondary
        ));
    }

    #[test]
    fn only_the_other_foreground_process_can_match() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        let windows = [window(99, 1.0, display), window(42, 1.0, display)];
        assert!(foreground_window_is_fullscreen(&windows, 42, 7, &[display]));
        assert!(!foreground_window_is_fullscreen(
            &windows,
            77,
            7,
            &[display]
        ));
        assert!(!foreground_window_is_fullscreen(
            &windows,
            42,
            42,
            &[display]
        ));
        assert!(!foreground_window_is_fullscreen(
            &windows,
            -1,
            7,
            &[display]
        ));
    }

    #[test]
    fn rear_fullscreen_window_does_not_override_a_normal_front_window() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        let windows = [
            window(42, 1.0, bounds(100.0, 100.0, 800.0, 600.0)),
            window(42, 1.0, display),
        ];
        assert!(!foreground_window_is_fullscreen(
            &windows,
            42,
            7,
            &[display]
        ));
    }

    #[test]
    fn transparent_and_sizeless_windows_are_not_foreground_candidates() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        let windows = [
            window(42, 0.0, display),
            window(42, 1.0, bounds(0.0, 0.0, 0.0, 982.0)),
            window(42, 1.0, bounds(0.0, 0.0, 1512.0, -1.0)),
            window(42, 1.0, display),
        ];
        assert!(foreground_window_is_fullscreen(&windows, 42, 7, &[display]));
        assert!(!foreground_window_is_fullscreen(
            &windows[..3],
            42,
            7,
            &[display]
        ));
    }

    #[test]
    fn non_finite_metadata_and_missing_displays_do_not_match() {
        let display = bounds(0.0, 0.0, 1512.0, 982.0);
        assert!(!matches_display(
            bounds(f64::NAN, 0.0, 1512.0, 982.0),
            display
        ));
        assert!(!matches_display(
            bounds(0.0, 0.0, f64::INFINITY, 982.0),
            display
        ));
        assert!(!foreground_window_is_fullscreen(
            &[window(42, f64::NAN, display)],
            42,
            7,
            &[display],
        ));
        assert!(!foreground_window_is_fullscreen(
            &[window(42, 1.0, display)],
            42,
            7,
            &[]
        ));
    }
}
