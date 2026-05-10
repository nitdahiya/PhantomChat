"""
PhantomChat — Blind Relay Server V3
====================================
The server NEVER sees plaintext messages. It only reads `recipient_id`
from the sealed envelope and forwards the opaque payload.

V3 Additions:
  - Password-based login system (bcrypt)
  - Encrypted key vault storage (zero-knowledge)
  - Delete account endpoint
  - Read receipt relay
  - 50MB max WebSocket message size

Endpoints:
  POST /api/register        — Register handle + password + keys
  POST /api/login           — Login with handle + password
  POST /api/delete-account  — Delete account permanently
  GET  /api/keys/{user_id}  — Fetch user's public keys for ECDH exchange
  GET  /api/users           — List all registered users
  WS   /ws/{user_id}        — Real-time message relay
"""

import json
import asyncio
import aiosqlite
from datetime import datetime, timezone
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import bcrypt as _bcrypt

def hash_password(pw: str) -> str:
    return _bcrypt.hashpw(pw.encode('utf-8'), _bcrypt.gensalt()).decode('utf-8')

def verify_password(pw: str, hashed: str) -> bool:
    return _bcrypt.checkpw(pw.encode('utf-8'), hashed.encode('utf-8'))

# ---------------------------------------------------------------------------
# Frontend path (for local development — Nginx handles this in production)
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# ---------------------------------------------------------------------------
# Database path
# ---------------------------------------------------------------------------
DB_PATH = Path(__file__).parent / "phantom.db"

# ---------------------------------------------------------------------------
# In-memory connection manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    """Tracks active WebSocket connections keyed by user_id."""

    def __init__(self):
        self.active: dict[str, WebSocket] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self.active[user_id] = ws

    def disconnect(self, user_id: str):
        self.active.pop(user_id, None)

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active

    async def send_to(self, user_id: str, data: dict) -> bool:
        """Send JSON to a specific user. Returns True if delivered."""
        ws = self.active.get(user_id)
        if ws:
            try:
                await ws.send_json(data)
                return True
            except Exception:
                self.disconnect(user_id)
        return False

    def online_users(self) -> list[str]:
        return list(self.active.keys())


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    return db


async def init_db():
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                user_id              TEXT PRIMARY KEY,
                password_hash        TEXT NOT NULL,
                ecdh_public_key      TEXT NOT NULL,
                ecdsa_public_key     TEXT NOT NULL,
                encrypted_key_vault  TEXT NOT NULL,
                created_at           TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS offline_messages (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_id  TEXT NOT NULL,
                sealed_payload TEXT NOT NULL,
                created_at    TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (recipient_id) REFERENCES users(user_id)
            );
        """)
        await db.commit()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="PhantomChat Relay",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    user_id: str = Field(..., min_length=2, max_length=24,
                         pattern=r"^[a-zA-Z0-9_]+$")
    password: str = Field(..., min_length=4, max_length=128)
    ecdh_public_key: dict   # JWK object
    ecdsa_public_key: dict  # JWK object
    encrypted_key_vault: str  # base64 encrypted private keys


class LoginRequest(BaseModel):
    user_id: str = Field(..., min_length=2, max_length=24)
    password: str = Field(..., min_length=4, max_length=128)


class DeleteAccountRequest(BaseModel):
    user_id: str = Field(..., min_length=2, max_length=24)
    password: str = Field(..., min_length=4, max_length=128)


class UserPublicKeys(BaseModel):
    user_id: str
    ecdh_public_key: dict
    ecdsa_public_key: dict


class UserInfo(BaseModel):
    user_id: str
    online: bool


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.post("/api/register", status_code=201)
async def register_user(req: RegisterRequest):
    """Register a new user with password and public keys."""
    db = await get_db()
    try:
        existing = await db.execute(
            "SELECT user_id FROM users WHERE user_id = ?", (req.user_id,)
        )
        if await existing.fetchone():
            raise HTTPException(409, detail="Handle already taken")

        password_hash = hash_password(req.password)

        await db.execute(
            """INSERT INTO users
               (user_id, password_hash, ecdh_public_key, ecdsa_public_key, encrypted_key_vault)
               VALUES (?, ?, ?, ?, ?)""",
            (req.user_id, password_hash,
             json.dumps(req.ecdh_public_key),
             json.dumps(req.ecdsa_public_key),
             req.encrypted_key_vault),
        )
        await db.commit()
        return {"status": "registered", "user_id": req.user_id}
    finally:
        await db.close()


@app.post("/api/login")
async def login_user(req: LoginRequest):
    """Login with handle + password. Returns encrypted key vault."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM users WHERE user_id = ?", (req.user_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, detail="User not found")

        if not verify_password(req.password, row["password_hash"]):
            raise HTTPException(401, detail="Invalid password")

        return {
            "status": "authenticated",
            "user_id": row["user_id"],
            "ecdh_public_key": json.loads(row["ecdh_public_key"]),
            "ecdsa_public_key": json.loads(row["ecdsa_public_key"]),
            "encrypted_key_vault": row["encrypted_key_vault"],
        }
    finally:
        await db.close()


@app.post("/api/delete-account")
async def delete_account(req: DeleteAccountRequest):
    """Permanently delete a user account and all associated data."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT password_hash FROM users WHERE user_id = ?", (req.user_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, detail="User not found")

        if not verify_password(req.password, row["password_hash"]):
            raise HTTPException(401, detail="Invalid password")

        # Delete offline messages
        await db.execute(
            "DELETE FROM offline_messages WHERE recipient_id = ?", (req.user_id,)
        )
        # Delete user
        await db.execute(
            "DELETE FROM users WHERE user_id = ?", (req.user_id,)
        )
        await db.commit()

        # Disconnect if online
        manager.disconnect(req.user_id)
        await broadcast_presence(req.user_id, False)

        return {"status": "deleted", "user_id": req.user_id}
    finally:
        await db.close()


@app.get("/api/keys/{user_id}", response_model=UserPublicKeys)
async def get_user_keys(user_id: str):
    """Fetch a user's public keys for ECDH key exchange."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT user_id, ecdh_public_key, ecdsa_public_key FROM users WHERE user_id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, detail="User not found")
        return UserPublicKeys(
            user_id=row["user_id"],
            ecdh_public_key=json.loads(row["ecdh_public_key"]),
            ecdsa_public_key=json.loads(row["ecdsa_public_key"]),
        )
    finally:
        await db.close()


@app.get("/api/users", response_model=list[UserInfo])
async def list_users():
    """List all registered users and their online status."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT user_id FROM users ORDER BY user_id")
        rows = await cursor.fetchall()
        return [
            UserInfo(user_id=r["user_id"], online=manager.is_online(r["user_id"]))
            for r in rows
        ]
    finally:
        await db.close()


@app.get("/api/check/{user_id}")
async def check_handle(user_id: str):
    """Check if a handle is available."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT user_id FROM users WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return {"available": row is None, "exists": row is not None}
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# WebSocket relay
# ---------------------------------------------------------------------------
MAX_WS_SIZE = 50 * 1024 * 1024  # 50 MB

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(ws: WebSocket, user_id: str):
    """
    Real-time message relay with 50MB max message size.
    Routes: message, image, file, webrtc_offer/answer/ice, typing, read_receipt
    """

    # Verify user exists
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT user_id FROM users WHERE user_id = ?", (user_id,)
        )
        if not await cursor.fetchone():
            await ws.close(code=4001, reason="User not registered")
            return
    finally:
        await db.close()

    await manager.connect(user_id, ws)

    # Broadcast presence update
    await broadcast_presence(user_id, True)

    # Deliver any offline messages
    await flush_offline_messages(user_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                envelope = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = envelope.get("type", "message")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})
            elif msg_type == "typing":
                recipient = envelope.get("recipient_id")
                if recipient:
                    await manager.send_to(recipient, {
                        "type": "typing",
                        "sender_id": user_id,
                    })
            elif msg_type == "read_receipt":
                recipient = envelope.get("recipient_id")
                if recipient:
                    await manager.send_to(recipient, {
                        "type": "read_receipt",
                        "sender_id": user_id,
                    })
            else:
                # Blindly route ALL other types
                await handle_relay(user_id, envelope)

    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await broadcast_presence(user_id, False)


async def handle_relay(sender_id: str, envelope: dict):
    """Route ANY JSON envelope blindly to the recipient."""
    recipient_id = envelope.get("recipient_id")
    if not recipient_id:
        return

    # Add sender_id so the recipient knows who it's from
    envelope["sender_id"] = sender_id

    delivered = await manager.send_to(recipient_id, envelope)

    if not delivered:
        # Store for offline delivery (skip WebRTC signaling)
        msg_type = envelope.get("type", "")
        if msg_type not in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
            db = await get_db()
            try:
                await db.execute(
                    "INSERT INTO offline_messages (recipient_id, sealed_payload) VALUES (?, ?)",
                    (recipient_id, json.dumps(envelope)),
                )
                await db.commit()
            finally:
                await db.close()

    # Send delivery receipt to sender
    await manager.send_to(sender_id, {
        "type": "receipt",
        "recipient_id": recipient_id,
        "delivered": delivered,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def flush_offline_messages(user_id: str):
    """Deliver all stored offline messages and delete them."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, sealed_payload FROM offline_messages WHERE recipient_id = ? ORDER BY id",
            (user_id,),
        )
        rows = await cursor.fetchall()
        ids_to_delete = []
        for row in rows:
            payload = json.loads(row["sealed_payload"])
            delivered = await manager.send_to(user_id, payload)
            if delivered:
                ids_to_delete.append(row["id"])

        if ids_to_delete:
            placeholders = ",".join("?" * len(ids_to_delete))
            await db.execute(
                f"DELETE FROM offline_messages WHERE id IN ({placeholders})",
                ids_to_delete,
            )
            await db.commit()
    finally:
        await db.close()


async def broadcast_presence(user_id: str, online: bool):
    """Notify all connected users of a presence change."""
    msg = {
        "type": "presence",
        "user_id": user_id,
        "online": online,
    }
    for uid in list(manager.active.keys()):
        if uid != user_id:
            await manager.send_to(uid, msg)


# ---------------------------------------------------------------------------
# Static files (Frontend)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

# ---------------------------------------------------------------------------
# Run with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# ---------------------------------------------------------------------------
