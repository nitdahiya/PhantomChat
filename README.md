# PhantomChat 👻

PhantomChat is a highly secure, end-to-end encrypted (E2EE), mobile-first web chat application designed for absolute privacy. It features perfect forward secrecy (PFS), zero-knowledge key vaulting, disappearing messages, and comprehensive anti-scraping protections.

## ✨ Features

*   **🔒 End-to-End Encryption**: Powered by Web Crypto API (ECDH P-384, AES-GCM-256). The backend relay server NEVER sees the plaintext content of your messages.
*   **🔄 Perfect Forward Secrecy (PFS)**: Generates a new ephemeral ECDH key pair for every single message. Even if a session key is compromised, past and future messages remain secure.
*   **🧠 Zero-Knowledge Vaulting**: Cryptographic keys are generated locally. Private keys are encrypted using AES-GCM (derived via PBKDF2 from your password) before being sent to the server. The server cannot decrypt your vault.
*   **💨 Disappearing Messages**: Set self-destruct timers (TTL) from 30 seconds to hours. Messages automatically dissolve with a smooth visual countdown ring.
*   **🛡️ Anti-Scraping Hardening**:
    *   **Flashbang & Blur**: Blocks `PrintScreen` (clears clipboard, blurs screen) and `Ctrl+P`.
    *   **Visibility Blur**: Tab switching instantly blurs the chat window.
    *   **Selection Lock**: Text selection and context menus are disabled.
    *   **Panic Button**: Double-tapping `ESC` instantly covers the screen with an innocent Wikipedia page.
*   **📱 Mobile-First UX**: Responsive sidebar, smooth animations, glassmorphism UI, and dark mode tailored for both desktop and mobile devices.
*   **📎 Large File Support**: Securely share images, videos, and documents up to 50MB using WebRTC P2P DataChannels (falling back to WebSocket blind relay if P2P fails). Includes an in-app encrypted media lightbox.
*   **⚡ Modern Stack**:
    *   **Backend**: Python, FastAPI, WebSockets, aiosqlite, bcrypt.
    *   **Frontend**: Vanilla HTML/CSS/JS, Service Worker (PWA-ready), Web Crypto API, WebRTC.

## 🚀 Quick Start (Local Development)

### Prerequisites
*   Python 3.10+
*   Node.js (optional, for serving frontend if you don't use FastAPI's static files)

### Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/YOUR_USERNAME/PhantomChat.git
    cd PhantomChat
    ```

2.  **Install backend dependencies:**
    ```bash
    cd backend
    pip install -r requirements.txt
    ```

3.  **Run the FastAPI relay server:**
    ```bash
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
    ```
    *The FastAPI backend is configured to automatically serve the static frontend files from the `/frontend` directory.*

4.  **Access the app:**
    Open your browser and navigate to `http://localhost:8000`.

## 🌐 Production Deployment

For production, it is highly recommended to serve the application behind a reverse proxy like **Nginx** with SSL/TLS enabled, as the Web Crypto API requires a secure context (HTTPS).

1.  **Nginx Configuration**: A sample `phantomchat.conf` is provided in the `nginx/` directory.
2.  **SSL Certificate**: Use Certbot (Let's Encrypt) to generate a free SSL certificate.
3.  **Process Manager**: Run the FastAPI backend using `systemd` or `pm2`.

## 🔐 Architecture Overview

1.  **Registration**: Client generates persistent ECDH and ECDSA key pairs. Public keys are sent to the server. Private keys are encrypted using a PBKDF2-derived key from the user's password, and the resulting "vault" is stored on the server.
2.  **Login**: Client fetches the encrypted vault, derives the decryption key from the password, and decrypts the private keys locally in volatile memory.
3.  **Message Flow**:
    *   Sender generates an ephemeral ECDH key pair.
    *   Sender derives a shared secret using their ephemeral private key and recipient's persistent public key.
    *   Message (and optional media) is encrypted with AES-GCM-256.
    *   Sender signs the ciphertext with their persistent ECDSA private key.
    *   Envelope containing ciphertext, signature, and ephemeral public key is sent via WebSocket to the server.
    *   Server blindly routes the envelope to the recipient (or stores it in an offline queue).
    *   Recipient derives the shared secret using their persistent private key and the sender's ephemeral public key to decrypt.

## ⚠️ Security Notice

While PhantomChat employs strong client-side encryption and various anti-scraping techniques, no system is perfectly secure. Specifically:
*   "Cryptographic shredding" of keys in memory is attempted via `crypto.getRandomValues`, but garbage collection behavior in modern browsers is not strictly deterministic.
*   Determined users can still take photos of their screens using external devices.

Use at your own risk. This project is provided as-is, primarily for educational and demonstrative purposes in secure web development.

## 📄 License

MIT License
