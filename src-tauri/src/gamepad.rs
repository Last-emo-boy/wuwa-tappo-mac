use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject, MainThreadMarker};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue};
use objc2_game_controller::{
    GCController, GCControllerButtonInput, GCControllerDidConnectNotification,
    GCControllerDidDisconnectNotification, GCExtendedGamepad,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter};

// Controller discovery and observer ownership stay on the application's main
// thread. Input callbacks only capture thread-safe event and cancellation state.
thread_local! {
    static MONITOR: RefCell<Option<GamepadMonitor>> = const { RefCell::new(None) };
}

struct GamepadMonitor {
    center: Retained<NSNotificationCenter>,
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    devices: BTreeMap<usize, Controller>,
    active: Arc<AtomicBool>,
    previous_background: bool,
}

struct Controller {
    _controller: Retained<GCController>,
    buttons: Vec<Retained<GCControllerButtonInput>>,
    active: Arc<AtomicBool>,
}

struct PressState(AtomicBool);

impl PressState {
    fn new(pressed: bool) -> Self {
        Self(AtomicBool::new(pressed))
    }

    fn update(&self, pressed: bool) -> bool {
        let previous = self.0.swap(pressed, Ordering::AcqRel);
        pressed && !previous
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        for button in &self.buttons {
            // The framework copied each block when installed. Removing the
            // handler releases it before we release the button/controller.
            unsafe { button.setPressedChangedHandler(std::ptr::null_mut()) };
        }
    }
}

impl Drop for GamepadMonitor {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        for observer in &self.observers {
            let object: &objc2::runtime::AnyObject = (**observer).as_ref();
            unsafe { self.center.removeObserver(object) };
        }
        self.devices.clear();
        unsafe { GCController::setShouldMonitorBackgroundEvents(self.previous_background) };
    }
}

fn buttons(gamepad: &GCExtendedGamepad) -> Vec<Retained<GCControllerButtonInput>> {
    // Match physical button presses: faces, D-pad, shoulders, triggers, stick
    // clicks and menu/options. Thumbstick axis movement is not a click.
    let mut buttons = unsafe {
        let dpad = gamepad.dpad();
        vec![
            gamepad.buttonA(),
            gamepad.buttonB(),
            gamepad.buttonX(),
            gamepad.buttonY(),
            dpad.up(),
            dpad.down(),
            dpad.left(),
            dpad.right(),
            gamepad.leftShoulder(),
            gamepad.rightShoulder(),
            gamepad.leftTrigger(),
            gamepad.rightTrigger(),
            gamepad.buttonMenu(),
        ]
    };
    unsafe {
        buttons.extend(gamepad.buttonOptions());
        buttons.extend(gamepad.leftThumbstickButton());
        buttons.extend(gamepad.rightThumbstickButton());
    }
    let mut seen = BTreeSet::new();
    buttons.retain(|button| seen.insert(Retained::as_ptr(button) as usize));
    buttons
}

fn attach(controller: Retained<GCController>, app: &AppHandle) -> Option<Controller> {
    let gamepad = unsafe { controller.extendedGamepad() }?;
    let buttons = buttons(&gamepad);
    let active = Arc::new(AtomicBool::new(true));
    for button in &buttons {
        // An already held button at startup/reconnect must be released before
        // it can contribute a new click.
        let pressed = PressState::new(unsafe { button.isPressed() });
        let active = active.clone();
        let app = app.clone();
        let handler = RcBlock::new(
            move |_: NonNull<GCControllerButtonInput>, _: f32, down: objc2::runtime::Bool| {
                if pressed.update(down.as_bool()) && active.load(Ordering::Acquire) {
                    // The official 1.0.2 consumer owns the game-mode/reporting
                    // gates. Keep this separate from keyboard and mouse streams.
                    if let Err(error) = app.emit("gamepad-button-press", ()) {
                        eprintln!("Game controller event delivery failed: {error}");
                    }
                }
            },
        );
        unsafe { button.setPressedChangedHandler(RcBlock::as_ptr(&handler)) };
    }
    Some(Controller {
        _controller: controller,
        buttons,
        active,
    })
}

fn refresh(app: &AppHandle) {
    debug_assert!(MainThreadMarker::new().is_some());
    let controllers = unsafe { GCController::controllers() };
    MONITOR.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(monitor) = slot.as_mut() else { return };
        let connected: BTreeSet<_> = controllers
            .iter()
            .map(|controller| Retained::as_ptr(&controller) as usize)
            .collect();
        monitor.devices.retain(|id, _| connected.contains(id));
        for controller in controllers {
            let id = Retained::as_ptr(&controller) as usize;
            if let std::collections::btree_map::Entry::Vacant(entry) = monitor.devices.entry(id) {
                if let Some(controller) = attach(controller, app) {
                    entry.insert(controller);
                }
            }
        }
    });
}

pub fn start(app: AppHandle) -> Result<(), String> {
    MainThreadMarker::new().ok_or("Game controllers must start on the main thread")?;
    if MONITOR.with(|slot| slot.borrow().is_some()) {
        return Ok(());
    }
    let center = NSNotificationCenter::defaultCenter();
    let active = Arc::new(AtomicBool::new(true));
    let previous_background = unsafe { GCController::shouldMonitorBackgroundEvents() };
    // A desktop pet must continue counting while the user's game is frontmost.
    // This does not capture or suppress the foreground game's controller input.
    unsafe { GCController::setShouldMonitorBackgroundEvents(true) };
    MONITOR.with(|slot| {
        *slot.borrow_mut() = Some(GamepadMonitor {
            center: center.clone(),
            observers: Vec::new(),
            devices: BTreeMap::new(),
            active: active.clone(),
            previous_background,
        });
    });
    for name in unsafe {
        [
            GCControllerDidConnectNotification,
            GCControllerDidDisconnectNotification,
        ]
    } {
        let app = app.clone();
        let active = active.clone();
        let handler = RcBlock::new(move |_: NonNull<NSNotification>| {
            if active.load(Ordering::Acquire) {
                refresh(&app);
            }
        });
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &handler,
            )
        };
        MONITOR.with(|slot| {
            if let Some(monitor) = slot.borrow_mut().as_mut() {
                monitor.observers.push(observer);
            }
        });
    }
    // Notifications cover hotplug; querying once covers controllers already
    // connected before application launch.
    refresh(&app);
    Ok(())
}

pub fn stop() -> Result<(), String> {
    MainThreadMarker::new().ok_or("Game controllers must stop on the main thread")?;
    MONITOR.with(|slot| {
        slot.borrow_mut().take();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_new_down_edge_counts() {
        let state = PressState::new(false);
        assert!(!state.update(false));
        assert!(state.update(true));
        assert!(!state.update(true));
        assert!(!state.update(false));
        assert!(!state.update(false));
        assert!(state.update(true));
    }

    #[test]
    fn startup_or_reconnect_does_not_count_an_already_held_button() {
        let state = PressState::new(true);
        assert!(!state.update(true));
        assert!(!state.update(false));
        assert!(state.update(true));
    }

    #[test]
    fn controllers_and_buttons_have_independent_edges() {
        let a = PressState::new(false);
        let b = PressState::new(false);
        assert!(a.update(true));
        assert!(b.update(true));
        assert!(!a.update(true));
        assert!(!b.update(false));
        assert!(b.update(true));
    }
}
