use futures_util::{future::AbortHandle, future::Abortable, SinkExt, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        self,
        client::IntoClientRequest,
        http::header,
        protocol::{CloseFrame, WebSocketConfig},
        Message,
    },
};

const HOST: &str = "api-mc-wuwatappo.kurogames-global.com";
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct SocketState {
    connections: Arc<Mutex<HashMap<(String, String), Connection>>>,
}

struct Connection {
    commands: mpsc::Sender<Command>,
    abort: AbortHandle,
    events: Channel<SocketEvent>,
    generation: Arc<()>,
}

enum Command {
    Send(Message, oneshot::Sender<Result<(), String>>),
    Close(Option<CloseFrame>),
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SocketEvent {
    Open {
        protocol: String,
        extensions: String,
    },
    Text {
        data: String,
    },
    Binary {
        data: Vec<u8>,
    },
    Error {
        message: String,
    },
    Close {
        code: u16,
        reason: String,
        #[serde(rename = "wasClean")]
        was_clean: bool,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
pub enum SocketData {
    Text(String),
    Binary(Vec<u8>),
}

fn validate_destination(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid WebSocket URL")?;
    if url.scheme() != "wss"
        || url.host_str() != Some(HOST)
        || url.port_or_known_default() != Some(443)
        || url.path() != "/socket.io/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Only the official CN WebSocket endpoint is allowed".into());
    }
    Ok(url)
}

fn validate_caller(label: &str, url: &Url) -> Result<(), String> {
    let local =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    if !matches!(label, "main" | "panel" | "login") || !local {
        return Err("WebSocket access requires a trusted app window".into());
    }
    Ok(())
}

fn caller_key(window: &WebviewWindow, id: &str) -> Result<(String, String), String> {
    validate_caller(
        window.label(),
        &window.url().map_err(|_| "Window location is unavailable")?,
    )?;
    if id.is_empty() || id.len() > 96 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid WebSocket id".into());
    }
    Ok((window.label().into(), id.into()))
}

fn protocol_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn request_for(url: &Url, protocols: &[String]) -> Result<tungstenite::http::Request<()>, String> {
    if protocols
        .iter()
        .enumerate()
        .any(|(i, value)| !protocol_token(value) || protocols[..i].contains(value))
    {
        return Err("Invalid WebSocket subprotocol".into());
    }
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid WebSocket request")?;
    if !protocols.is_empty() {
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            protocols
                .join(", ")
                .parse()
                .map_err(|_| "Invalid WebSocket subprotocol")?,
        );
    }
    // Native clients do not have a browser Origin. No caller-supplied headers are accepted.
    Ok(request)
}

fn safe_error(error: &tungstenite::Error) -> String {
    match error {
        tungstenite::Error::Http(response) => format!(
            "WebSocket handshake rejected (HTTP {})",
            response.status().as_u16()
        ),
        tungstenite::Error::Io(_) => "WebSocket network connection failed".into(),
        tungstenite::Error::Tls(_) => "WebSocket TLS connection failed".into(),
        _ => "WebSocket protocol connection failed".into(),
    }
}

fn failed(events: &Channel<SocketEvent>, message: &str) {
    let _ = events.send(SocketEvent::Error {
        message: message.into(),
    });
    let _ = events.send(SocketEvent::Close {
        code: 1006,
        reason: String::new(),
        was_clean: false,
    });
}

async fn run_connection(
    request: tungstenite::http::Request<()>,
    events: Channel<SocketEvent>,
    mut commands: mpsc::Receiver<Command>,
) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let result = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, connect_async_with_config(request, Some(config), false)) => result,
        command = commands.recv() => {
            if let Some(Command::Send(_, reply)) = command { let _ = reply.send(Err("WebSocket is not open".into())); }
            failed(&events, "WebSocket closed before connecting");
            return;
        }
    };
    let (mut socket, response) = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            failed(&events, &safe_error(&error));
            return;
        }
        Err(_) => {
            failed(&events, "WebSocket connection timed out");
            return;
        }
    };
    let header_value = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    if events
        .send(SocketEvent::Open {
            protocol: header_value(header::SEC_WEBSOCKET_PROTOCOL),
            extensions: header_value(header::SEC_WEBSOCKET_EXTENSIONS),
        })
        .is_err()
    {
        return;
    }
    let mut closing_at = None;
    loop {
        let deadline =
            closing_at.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86400));
        tokio::select! {
            _ = tokio::time::sleep_until(deadline), if closing_at.is_some() => {
                let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new(), was_clean: false });
                return;
            }
            command = commands.recv() => match command {
                Some(Command::Send(message, reply)) if closing_at.is_none() => {
                    let result = tokio::time::timeout(CONNECT_TIMEOUT, socket.send(message)).await;
                    let status = match result {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(safe_error(&error)),
                        Err(_) => Err("WebSocket send timed out".into()),
                    };
                    let error = status.as_ref().err().cloned();
                    let _ = reply.send(status);
                    if let Some(error) = error { failed(&events, &error); return; }
                }
                Some(Command::Send(_, reply)) => { let _ = reply.send(Err("WebSocket is closing".into())); }
                Some(Command::Close(frame)) if closing_at.is_none() => {
                    closing_at = Some(tokio::time::Instant::now() + CLOSE_TIMEOUT);
                    if !tokio::time::timeout(CLOSE_TIMEOUT, socket.send(Message::Close(frame))).await.is_ok_and(|result| result.is_ok()) {
                        failed(&events, "WebSocket close failed"); return;
                    }
                }
                Some(Command::Close(_)) => {}
                None => return,
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if events.send(SocketEvent::Text { data: text.to_string() }).is_err() { return; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if events.send(SocketEvent::Binary { data: bytes.to_vec() }).is_err() { return; }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string())).unwrap_or((1005, String::new()));
                    let clean = tokio::time::timeout(CLOSE_TIMEOUT, socket.flush()).await.is_ok_and(|result| result.is_ok());
                    let _ = events.send(SocketEvent::Close { code, reason, was_clean: clean });
                    return;
                }
                Some(Ok(Message::Ping(_))) => {
                    if !tokio::time::timeout(CONNECT_TIMEOUT, socket.flush()).await.is_ok_and(|result| result.is_ok()) {
                        failed(&events, "WebSocket heartbeat failed"); return;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => { failed(&events, &safe_error(&error)); return; }
                None => {
                    let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new(), was_clean: false });
                    return;
                }
            }
        }
    }
}

#[tauri::command]
pub fn native_ws_connect(
    window: WebviewWindow,
    state: State<'_, SocketState>,
    id: String,
    url: String,
    protocols: Vec<String>,
    events: Channel<SocketEvent>,
) -> Result<(), String> {
    let key = caller_key(&window, &id)?;
    let request = request_for(&validate_destination(&url)?, &protocols)?;
    let (sender, receiver) = mpsc::channel(32);
    let (abort, registration) = AbortHandle::new_pair();
    let generation = Arc::new(());
    {
        let mut connections = state
            .connections
            .lock()
            .map_err(|_| "WebSocket state is unavailable")?;
        if connections.contains_key(&key) {
            return Err("WebSocket id already exists".into());
        }
        if connections.len() >= 16 {
            return Err("Too many WebSocket connections".into());
        }
        connections.insert(
            key.clone(),
            Connection {
                commands: sender,
                abort,
                events: events.clone(),
                generation: generation.clone(),
            },
        );
    }
    let connections = state.connections.clone();
    tauri::async_runtime::spawn(async move {
        let _ = Abortable::new(run_connection(request, events, receiver), registration).await;
        if let Ok(mut connections) = connections.lock() {
            if connections
                .get(&key)
                .is_some_and(|connection| Arc::ptr_eq(&connection.generation, &generation))
            {
                connections.remove(&key);
            }
        }
    });
    Ok(())
}

fn sender(
    window: &WebviewWindow,
    state: &SocketState,
    id: &str,
) -> Result<mpsc::Sender<Command>, String> {
    let key = caller_key(window, id)?;
    state
        .connections
        .lock()
        .map_err(|_| "WebSocket state is unavailable")?
        .get(&key)
        .map(|connection| connection.commands.clone())
        .ok_or_else(|| "WebSocket is closed".into())
}

#[tauri::command]
pub async fn native_ws_send(
    window: WebviewWindow,
    state: State<'_, SocketState>,
    id: String,
    data: SocketData,
) -> Result<(), String> {
    let sender = sender(&window, &state, &id)?;
    let message = match data {
        SocketData::Text(value) if value.len() <= MAX_MESSAGE_BYTES => Message::Text(value.into()),
        SocketData::Binary(value) if value.len() <= MAX_MESSAGE_BYTES => {
            Message::Binary(value.into())
        }
        _ => return Err("WebSocket message is too large".into()),
    };
    let (reply, result) = oneshot::channel();
    sender
        .send(Command::Send(message, reply))
        .await
        .map_err(|_| "WebSocket is closed")?;
    result.await.map_err(|_| "WebSocket is closed")?
}

fn close_frame(code: Option<u16>, reason: String) -> Result<Option<CloseFrame>, String> {
    if reason.len() > 123 || code.is_some_and(|code| code != 1000 && !(3000..=4999).contains(&code))
    {
        return Err("Invalid WebSocket close code or reason".into());
    }
    Ok(code.map(|code| CloseFrame {
        code: code.into(),
        reason: reason.into(),
    }))
}

#[tauri::command]
pub async fn native_ws_close(
    window: WebviewWindow,
    state: State<'_, SocketState>,
    id: String,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    let sender = sender(&window, &state, &id)?;
    let frame = close_frame(code, reason.unwrap_or_default())?;
    sender
        .send(Command::Close(frame))
        .await
        .map_err(|_| "WebSocket is closed".into())
}

fn remove_connections(state: &SocketState, label: Option<&str>) {
    if let Ok(mut connections) = state.connections.lock() {
        connections.retain(|(owner, _), connection| {
            if label.is_none_or(|label| owner == label) {
                connection.abort.abort();
                let _ = connection.events.send(SocketEvent::Close {
                    code: 1001,
                    reason: String::new(),
                    was_clean: false,
                });
                false
            } else {
                true
            }
        });
    }
}

pub fn close_window(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<SocketState>() {
        remove_connections(&state, Some(label));
    }
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SocketState>() {
        remove_connections(&state, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_exact_and_never_adds_origin_or_cookie() {
        let url = validate_destination(&format!(
            "wss://{HOST}/socket.io/?EIO=3&transport=websocket&token=synthetic"
        ))
        .unwrap();
        let request = request_for(&url, &[]).unwrap();
        assert!(!request.headers().contains_key(header::ORIGIN));
        assert!(!request.headers().contains_key(header::COOKIE));
        for value in [
            format!("ws://{HOST}/socket.io/"),
            format!("wss://{HOST}:444/socket.io/"),
            format!("wss://{HOST}/other"),
            format!("wss://{HOST}.example/socket.io/"),
            format!("wss://user@{HOST}/socket.io/"),
            format!("wss://{HOST}/socket.io/#fragment"),
        ] {
            assert!(validate_destination(&value).is_err());
        }
    }

    #[test]
    fn only_local_consumers_can_use_the_bridge() {
        for label in ["main", "panel", "login"] {
            assert!(
                validate_caller(label, &Url::parse("tauri://localhost/index.html").unwrap())
                    .is_ok()
            );
        }
        for (label, url) in [
            ("bootstrap", "tauri://localhost"),
            ("main", "https://example.com"),
            ("main", "http://tauri.localhost:43127"),
            ("main", "tauri://foreign"),
        ] {
            assert!(validate_caller(label, &Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn subprotocol_and_close_inputs_follow_websocket_rules() {
        let url = validate_destination(&format!("wss://{HOST}/socket.io/")).unwrap();
        assert_eq!(
            request_for(&url, &["sample.v1".into()]).unwrap().headers()
                [header::SEC_WEBSOCKET_PROTOCOL],
            "sample.v1"
        );
        assert!(request_for(&url, &["a,b".into()]).is_err());
        assert!(request_for(&url, &["same".into(), "same".into()]).is_err());
        assert!(close_frame(Some(1000), String::new()).is_ok());
        assert!(close_frame(Some(3001), "done".into()).is_ok());
        assert!(close_frame(Some(1006), String::new()).is_err());
        assert!(close_frame(Some(1000), "x".repeat(124)).is_err());
    }

    #[test]
    fn window_cleanup_aborts_only_its_connections_and_shutdown_clears_the_rest() {
        let state = SocketState::default();
        let mut handles = Vec::new();
        for label in ["main", "panel"] {
            let (sender, _receiver) = mpsc::channel(1);
            let (abort, _registration) = AbortHandle::new_pair();
            handles.push(abort.clone());
            state.connections.lock().unwrap().insert(
                (label.into(), "synthetic".into()),
                Connection {
                    commands: sender,
                    abort,
                    events: Channel::new(|_| Ok(())),
                    generation: Arc::new(()),
                },
            );
        }
        remove_connections(&state, Some("panel"));
        assert_eq!(state.connections.lock().unwrap().len(), 1);
        assert!(!handles[0].is_aborted());
        assert!(handles[1].is_aborted());
        remove_connections(&state, None);
        assert!(state.connections.lock().unwrap().is_empty());
        assert!(handles[0].is_aborted());
    }

    #[tokio::test]
    async fn local_transport_round_trip_preserves_text_binary_and_close() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Message::Text("hello".into())).await.unwrap();
            socket
                .send(Message::Binary(vec![1, 2, 3].into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Text("sent".into())
            );
            socket
                .close(Some(CloseFrame {
                    code: 1000.into(),
                    reason: "done".into(),
                }))
                .await
                .unwrap();
            let _ = socket.next().await;
        });
        let (events_sender, mut received) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(value) = body {
                let value: serde_json::Value = serde_json::from_str(&value).unwrap();
                let _ = events_sender.send(value);
            }
            Ok(())
        });
        let request = request_for(
            &Url::parse(&format!("ws://{address}/socket.io/")).unwrap(),
            &[],
        )
        .unwrap();
        let (sender, receiver) = mpsc::channel(4);
        let client = tokio::spawn(run_connection(request, events, receiver));
        async fn next(
            received: &mut mpsc::UnboundedReceiver<serde_json::Value>,
        ) -> serde_json::Value {
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap()
        }
        assert_eq!(next(&mut received).await["type"], "open");
        assert_eq!(next(&mut received).await["data"], "hello");
        assert_eq!(
            next(&mut received).await["data"],
            serde_json::json!([1, 2, 3])
        );
        let (reply, result) = oneshot::channel();
        sender
            .send(Command::Send(Message::Text("sent".into()), reply))
            .await
            .unwrap();
        result.await.unwrap().unwrap();
        let closed = next(&mut received).await;
        assert_eq!(closed["type"], "close");
        assert_eq!(closed["code"], 1000);
        assert_eq!(closed["reason"], "done");
        assert_eq!(closed["wasClean"], true);
        tokio::time::timeout(Duration::from_secs(2), client)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
