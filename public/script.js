const socket = io(window.location.origin, {
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 10 * 1024 * 1024,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
    timeout: 20000
});
let user = "";

socket.on("connect", () => {
    console.log("Socket connected.");
    if (user) {
        socket.emit("join", user);
    }
    flushPendingMessages();
});

socket.on("reconnect", () => {
    console.log("Socket reconnected.");
    flushPendingMessages();
});

socket.on("connect_error", (err) => {
    console.error("Socket connect error:", err);
});

socket.on("reconnect_error", (err) => {
    console.error("Socket reconnect error:", err);
});

socket.on("disconnect", (reason) => {
    console.warn("Socket disconnected:", reason);
});

function enqueuePendingMessage(payload, tempId, retryCount = 0) {
    pendingMessageQueue.push({ payload, tempId, retryCount });
}

function flushPendingMessages() {
    if (!socket.connected) return;
    while (pendingMessageQueue.length > 0) {
        const { payload, tempId, retryCount } = pendingMessageQueue.shift();
        sendEncryptedMessage(payload, tempId, retryCount);
    }
}
let avatar = "";
let currentChat = "";
let recipient = "";
let peerConnection;
let localStream;
let mediaRecorder;
let audioChunks = [];
let recordedAudioBlob = null;
let shouldAutoSendRecording = false;
let recordingStream = null;
let remoteAudio;
let remoteVideo;
let currentCallTarget = "";
let incomingCall = false;
let pendingOffer = null;
let typingTimer;
let isTyping = false;
let editingMessageId = null;
let savedUsername = localStorage.getItem("savedUsername") || "";
let publicKeys = {};
let publicKeyPromises = {};
let privateKey = null;
let myPublicKey = null;
let myPublicKeyString = "";
let inactivityTimer;
let activityListenersAdded = false;
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
let pendingStopRecording = false;
let pendingMessageQueue = [];
let chats = {}; // Store chat data
let onlineUsers = [];
let currentReply = null;
let messageReactions = {}; // Store reactions for messages
let currentZoom = 100; // Track zoom level
let currentTheme = localStorage.getItem("appTheme") || "dark";
let isSending = false;

function applyTheme(theme) {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    localStorage.setItem("appTheme", theme);
    currentTheme = theme;
}

function initTheme() {
    applyTheme(currentTheme);
    const themeSelector = document.getElementById("themeSelector");
    if (themeSelector) {
        themeSelector.value = currentTheme;
        themeSelector.addEventListener("change", (e) => {
            applyTheme(e.target.value);
        });
    }
}

async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function resolveAvatarValue(urlInputId, fileInputId, fallbackUsername) {
    const url = document.getElementById(urlInputId).value.trim();
    const fileInput = document.getElementById(fileInputId);
    if (fileInput && fileInput.files && fileInput.files[0]) {
        return await fileToDataUrl(fileInput.files[0]);
    }
    if (url) {
        return url;
    }
    return getDefaultAvatar(fallbackUsername);
}

function showNewChatModal() {
    document.getElementById("newChatModal").style.display = "block";
}

function closeNewChatModal() {
    document.getElementById("newChatModal").style.display = "none";
    document.getElementById("newChatUser").value = "";
}

function startNewChat() {
    const username = document.getElementById("newChatUser").value.trim();
    if (!username) {
        alert("Please enter a username.");
        return;
    }
    if (username === user) {
        alert("You cannot chat with yourself.");
        return;
    }

    currentChat = username;
    recipient = username;
    localStorage.setItem("sessionCurrentChat", currentChat);
    if (!chats[currentChat]) {
        chats[currentChat] = {
            messages: [],
            unreadCount: 0,
            lastMessage: null,
            avatar: getDefaultAvatar(username)
        };
    }

    updateChatUI();
    closeNewChatModal();
    socket.emit("join", user);
}

function showAttachmentMenu() {
    document.getElementById("attachmentModal").style.display = "block";
}

function closeAttachmentModal() {
    document.getElementById("attachmentModal").style.display = "none";
}

function toggleEmojiPicker() {
    const picker = document.getElementById("emojiPicker");
    if (!picker) return;
    picker.style.display = picker.style.display === "block" ? "none" : "block";
}

function insertEmoji(emoji) {
    const msgInput = document.getElementById("msg");
    if (!msgInput) return;
    msgInput.value += emoji;
    msgInput.focus();
}

function shareImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            sendImage(file);
        }
    };
    input.click();
    closeAttachmentModal();
}

function shareVideo() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            sendVideo(file);
        }
    };
    input.click();
    closeAttachmentModal();
}

function shareFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            sendFile(file);
        }
    };
    input.click();
    closeAttachmentModal();
}

async function sendImage(file) {
    if (!currentChat) {
        alert("Select a chat first.");
        return;
    }

    try {
        const base64 = await fileToDataUrl(file);
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        const encrypted = await encryptMessage(base64, recipientPublicKey, myPublicKey, currentChat);
        const tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const localMessage = {
            from: user,
            to: currentChat,
            type: "image",
            imageData: base64,
            tempId,
            status: "sending",
            avatar,
            time: new Date().toISOString()
        };
        if (!chats[currentChat]) {
            chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
        }
        chats[currentChat].messages.push(localMessage);
        if (currentChat === localMessage.to) {
            addMessage(localMessage);
            updateChatUI();
            autoScrollMessages();
        }

        sendEncryptedMessage({
            to: currentChat,
            type: "image",
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId
        }, tempId);
    } catch (err) {
        console.error(err);
        alert("Failed to send image.");
    }
}

async function sendVideo(file) {
    if (!currentChat) {
        alert("Select a chat first.");
        return;
    }

    try {
        const base64 = await fileToDataUrl(file);
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        const encrypted = await encryptMessage(base64, recipientPublicKey, myPublicKey, currentChat);
        const tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const localMessage = {
            from: user,
            to: currentChat,
            type: "video",
            videoData: base64,
            tempId,
            status: "sending",
            avatar,
            time: new Date().toISOString()
        };
        if (!chats[currentChat]) {
            chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
        }
        chats[currentChat].messages.push(localMessage);
        if (currentChat === localMessage.to) {
            addMessage(localMessage);
            updateChatUI();
            autoScrollMessages();
        }

        sendEncryptedMessage({
            to: currentChat,
            type: "video",
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId
        }, tempId);
    } catch (err) {
        console.error(err);
        alert("Failed to send video.");
    }
}

async function sendFile(file) {
    if (!currentChat) {
        alert("Select a chat first.");
        return;
    }

    try {
        const base64 = await fileToDataUrl(file);
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        const encrypted = await encryptMessage(JSON.stringify({
            name: file.name,
            size: file.size,
            data: base64
        }), recipientPublicKey, myPublicKey, currentChat);
        const tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const localMessage = {
            from: user,
            to: currentChat,
            type: "file",
            fileData: {
                name: file.name,
                size: file.size,
                data: base64
            },
            tempId,
            status: "sending",
            avatar,
            time: new Date().toISOString()
        };
        if (!chats[currentChat]) {
            chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
        }
        chats[currentChat].messages.push(localMessage);
        if (currentChat === localMessage.to) {
            addMessage(localMessage);
            updateChatUI();
            autoScrollMessages();
        }

        sendEncryptedMessage({
            to: currentChat,
            type: "file",
            fileName: file.name,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId
        }, tempId);
    } catch (err) {
        console.error(err);
        alert("Failed to send file.");
    }
}

async function startVideoCall() {
    if (!user) {
        alert("Login first to start a video call.");
        return;
    }
    if (currentCallTarget) {
        alert("A call is already in progress.");
        return;
    }

    const selectedUser = currentChat;
    if (!selectedUser) {
        alert("Select a chat first.");
        return;
    }
    if (selectedUser === user) {
        alert("You cannot call yourself.");
        return;
    }

    currentCallTarget = selectedUser;
    document.getElementById("callModal").style.display = "block";
    document.getElementById("callUser").innerText = selectedUser;
    document.getElementById("callAvatar").src = chats[selectedUser]?.avatar || getDefaultAvatar(selectedUser);
    document.getElementById("callStatus").innerText = "Calling...";
    updateCallButtons("active");

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        peerConnection = new RTCPeerConnection();

        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
        peerConnection.ontrack = (event) => {
            if (remoteAudio) {
                remoteAudio.srcObject = event.streams[0];
            }
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
            }
        };
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("iceCandidate", { candidate: event.candidate, to: selectedUser });
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("callUser", { offer, to: selectedUser });
    } catch (err) {
        console.error(err);
        alert(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Microphone/camera access is required for calls. Please allow access and try again."
            : "Unable to start the video call. Please try again.");
        endCall();
    }
}

function showChatInfo() {
    // TODO: Implement chat info modal
    alert("Chat info feature coming soon!");
}

function filterChats() {
    const searchTerm = document.getElementById("searchChats").value.toLowerCase();
    const chatItems = document.querySelectorAll(".chat-item");

    chatItems.forEach(item => {
        const name = item.querySelector(".chat-item-name").innerText.toLowerCase();
        if (name.includes(searchTerm)) {
            item.style.display = "flex";
        } else {
            item.style.display = "none";
        }
    });
}

function updateChatUI(updateMessages = true) {
    // Update sidebar chats
    const chatsList = document.getElementById("chatsList");
    chatsList.innerHTML = "";

    Object.keys(chats).forEach(chatUser => {
        const chat = chats[chatUser];
        const chatItem = document.createElement("div");
        chatItem.className = `chat-item ${chatUser === currentChat ? 'active' : ''}`;
        chatItem.onclick = () => selectChat(chatUser);

        const isOnline = onlineUsers.includes(chatUser);
        const statusBadge = isOnline ? '<span class="chat-item-status">Active</span>' : '';

        const lastMsg = chat.lastMessage;
        let lastMsgText = "No messages yet";
        if (lastMsg) {
            if (lastMsg.type === "text") {
                lastMsgText = lastMsg.msg || "No message";
            } else if (lastMsg.type === "image") {
                lastMsgText = "Sent an image";
            } else if (lastMsg.type === "video") {
                lastMsgText = "Sent a video";
            } else if (lastMsg.type === "audio") {
                lastMsgText = "Sent a voice clip";
            } else if (lastMsg.type === "file") {
                lastMsgText = "Sent a file";
            } else {
                lastMsgText = "Sent a message";
            }
        }
        const time = lastMsg ? new Date(lastMsg.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "";

        chatItem.innerHTML = `
            <img src="${chat.avatar}" class="avatar">
            <div class="chat-item-info">
                <div class="chat-item-name">${chatUser} ${statusBadge}</div>
                <div class="chat-item-last-msg">${lastMsgText}</div>
            </div>
            <div class="chat-item-meta">
                <div class="chat-item-time">${time}</div>
                ${chat.unreadCount > 0 ? `<div class="unread-badge">${chat.unreadCount}</div>` : ''}
            </div>
        `;

        chatsList.appendChild(chatItem);
    });

    // Update main chat area
    if (updateMessages && currentChat) {
        document.getElementById("chatTitle").innerText = currentChat;
        document.getElementById("headerAvatar").src = chats[currentChat]?.avatar || getDefaultAvatar(currentChat);
        document.getElementById("chatSubtitle").innerText = onlineUsers.includes(currentChat) ? "Active now" : "Offline";

        // Clear messages and load current chat messages
        console.log("Clearing messages in updateChatUI for currentChat:", currentChat);
        document.getElementById("messages").innerHTML = "";
        if (chats[currentChat]) {
            chats[currentChat].messages.forEach(msg => addMessage(msg));
            chats[currentChat].unreadCount = 0;
        }
    } else if (!updateMessages && currentChat) {
        // Only update subtitle for online status
        document.getElementById("chatSubtitle").innerText = onlineUsers.includes(currentChat) ? "Active now" : "Offline";
    } else if (!currentChat) {
        document.getElementById("chatTitle").innerText = "Select a chat";
        document.getElementById("chatSubtitle").innerText = "Tap to start chatting";
        document.getElementById("headerAvatar").src = avatar || "https://i.pravatar.cc/40";
        document.getElementById("messages").innerHTML = "";
    }
}

function selectChat(chatUser) {
    if (currentChat === chatUser) {
        // Already selected, just ensure UI is up to date
        return;
    }
    currentChat = chatUser;
    recipient = chatUser;
    localStorage.setItem("sessionCurrentChat", currentChat);
    if (chats[chatUser]) {
        chats[chatUser].unreadCount = 0;
    }
    // updateChatUI(); // Removed to prevent blinking, let loadMessages handle it
    socket.emit("join", user);
    void preloadPublicKey(chatUser);
    if (window.matchMedia('(max-width: 960px)').matches) {
        document.querySelector('.chat-container')?.classList.remove('sidebar-open');
    }
}

function toggleSidebar() {
    document.querySelector('.chat-container')?.classList.toggle('sidebar-open');
}

async function preloadPublicKey(username) {
    try {
        await getPublicKeyFor(username);
    } catch (err) {
        console.warn("Unable to preload public key for", username, err);
    }
}

function addReactionToMessage(messageId, emoji) {
    if (!messageReactions[messageId]) {
        messageReactions[messageId] = {};
    }

    if (!messageReactions[messageId][emoji]) {
        messageReactions[messageId][emoji] = [];
    }

    if (!messageReactions[messageId][emoji].includes(user)) {
        messageReactions[messageId][emoji].push(user);
        socket.emit("addReaction", { messageId, emoji });
        updateMessageReactions(messageId);
    }
}

function updateMessageReactions(messageId) {
    const messageDiv = document.querySelector(`[data-id="${messageId}"]`);
    if (!messageDiv) return;

    const reactionsDiv = messageDiv.querySelector('.reactions');
    if (!reactionsDiv) return;

    reactionsDiv.innerHTML = "";

    if (messageReactions[messageId]) {
        Object.entries(messageReactions[messageId]).forEach(([emoji, users]) => {
            if (users.length > 0) {
                const reactionDiv = document.createElement("div");
                reactionDiv.className = "reaction";
                reactionDiv.innerHTML = `${emoji} <span class="reaction-count">${users.length}</span>`;
                reactionsDiv.appendChild(reactionDiv);
            }
        });
    }
}

function showReactionModal(messageId) {
    document.getElementById("reactionModal").style.display = "block";
    // Store messageId for reaction handler
    window.currentReactionMessageId = messageId;
}

function addReaction(emoji) {
    if (window.currentReactionMessageId) {
        addReactionToMessage(window.currentReactionMessageId, emoji);
    }
    document.getElementById("reactionModal").style.display = "none";
}

function startRecordingHold(event) {
    event.preventDefault();
    if (isRecordingHold || !currentChat) {
        alert("Choose a chat before recording audio.");
        return;
    }
    if (!privateKey || !myPublicKey) {
        alert("Secure messaging is unavailable because the account keys are missing.");
        return;
    }
    isRecordingHold = true;
    recordingCancelled = false;
    recordStartX = event.touches ? event.touches[0].clientX : event.clientX;
    const recordBtn = document.getElementById("voiceBtn") || document.querySelector(".voice-btn");
    if (recordBtn) recordBtn.innerHTML = '<i class="fas fa-stop"></i>';
    beginRecording();
}

function stopRecordingHold(event) {
    if (!isRecordingHold) return;
    const currentX = event.changedTouches ? event.changedTouches[0].clientX : event.clientX;
    if (recordStartX - currentX > recordCancelThreshold) {
        recordingCancelled = true;
    }
    isRecordingHold = false;
    pendingStopRecording = true;
    const recordBtn = document.getElementById("voiceBtn") || document.querySelector(".voice-btn");
    if (recordBtn) recordBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    if (mediaRecorder && mediaRecorder.state === "recording") {
        pendingStopRecording = false;
        mediaRecorder.stop();
    }
}

function cancelRecordingHold() {
    if (!isRecordingHold) return;
    recordingCancelled = true;
    isRecordingHold = false;
    const recordBtn = document.getElementById("voiceBtn") || document.querySelector(".voice-btn");
    if (recordBtn) recordBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
    }
}

async function sendRecordedAudio() {
    if (!currentChat) {
        alert("Choose a recipient before sending an audio message.");
        return;
    }
    if (!recordedAudioBlob) {
        return;
    }

    let tempId;
    try {
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        const base64Audio = await blobToBase64(recordedAudioBlob);
        const encrypted = await encryptMessage(base64Audio, recipientPublicKey, myPublicKey, currentChat);
        tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const localMessage = {
            from: user,
            to: currentChat,
            type: "audio",
            audioBase64: base64Audio,
            tempId,
            status: "sending",
            avatar,
            time: new Date().toISOString()
        };

        if (!chats[currentChat]) {
            chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
        }
        chats[currentChat].messages.push(localMessage);
        if (currentChat === localMessage.to) {
            addMessage(localMessage);
            updateChatUI();
            autoScrollMessages();
        }

        sendEncryptedMessage({
            to: currentChat,
            type: "audio",
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId
        }, tempId);

        clearRecording();
    } catch (err) {
        console.error(err);
        console.warn(`Unable to send audio message ${tempId} right now. It will remain in sending state.`);
        alert(err.message || "Unable to send audio message.");
    }
}

async function deleteAccount() {
    const password = document.getElementById("oldPass").value;
    if (!password) {
        alert("Please enter your current password to delete your account.");
        return;
    }
    if (!confirm("Delete your account permanently? This cannot be undone.")) {
        return;
    }

    const response = await fetch("/deleteAccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password })
    });
    const data = await response.json();
    if (!data.success) {
        alert(data.error);
        return;
    }
    alert("Your account has been deleted.");
    localStorage.removeItem("savedUsername");
    logout();
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        logout();
        alert("You have been logged out due to inactivity.");
    }, INACTIVITY_TIMEOUT);
}

function addActivityListeners() {
    if (activityListenersAdded) return;
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
    events.forEach(event => {
        document.addEventListener(event, resetInactivityTimer, true);
    });
    activityListenersAdded = true;
}

function getDefaultAvatar(username) {
    return `https://i.pravatar.cc/150?u=${encodeURIComponent(username)}`;
}

window.onload = async () => {
    remoteAudio = document.getElementById("remoteAudio");
    remoteVideo = document.getElementById("remoteVideo");
    updateCallButtons("none");
    
    // Restore zoom level
    const savedZoom = localStorage.getItem("chatZoom");
    if (savedZoom) {
        currentZoom = parseInt(savedZoom);
        applyZoom();
    }

    const sessionUser = localStorage.getItem("sessionUser");
    if (sessionUser) {
        user = sessionUser;
        avatar = localStorage.getItem("sessionAvatar") || getDefaultAvatar(user);
        currentChat = localStorage.getItem("sessionCurrentChat") || "";
        recipient = currentChat;

        const sessionPublicKey = localStorage.getItem("sessionPublicKey");
        const sessionPrivateKey = localStorage.getItem("sessionPrivateKey");
        if (sessionPublicKey) {
            myPublicKeyString = sessionPublicKey;
            try {
                myPublicKey = await importPublicKey(sessionPublicKey);
            } catch (err) {
                console.warn("Could not restore public key from session.", err);
            }
        }
        if (sessionPrivateKey) {
            try {
                privateKey = await importPrivateKey(sessionPrivateKey);
            } catch (err) {
                console.warn("Could not restore private key from session.", err);
            }
        }

        document.getElementById("user").value = user;
        enterChat();
        return;
    }

    if (savedUsername) {
        document.getElementById("user").value = savedUsername;
    }
};

async function register() {
    const username = document.getElementById("user").value.trim();
    const password = document.getElementById("pass").value;
    const secret = document.getElementById("secret").value || "";

    if (!username || !password) {
        alert("Username and password are required.");
        return;
    }

    if (username.length < 3 || username.length > 20) {
        alert("Username must be 3-20 characters.");
        return;
    }

    if (password.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
    }

    if (!secret) {
        alert("Secret code is required.");
        return;
    }

    try {
        const avatarValue = await resolveAvatarValue("avatarUrl", "avatarFile", username);
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            },
            true,
            ["encrypt", "decrypt"]
        );

        const publicKey = await exportPublicKey(keyPair.publicKey);
        const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
        const encryptedPrivate = await encryptPrivateKey(privateKeyBytes, password);

        const url = `${window.location.origin}/register`;
        console.log(`Registering at: ${url}`);
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username,
                password,
                secret,
                avatar: avatarValue,
                publicKey,
                encryptedPrivateKey: encryptedPrivate.encrypted,
                privateKeySalt: encryptedPrivate.salt,
                privateKeyIv: encryptedPrivate.iv
            })
        });
        const data = await response.json();
        alert(data.success ? "Registered! You can now login." : data.error);
    } catch (err) {
        console.error(err);
        alert("Registration failed. Please try again.");
    }
}

window.register = register;

async function login() {
    const username = document.getElementById("user").value.trim();
    const password = document.getElementById("pass").value;

    if (!username || !password) {
        alert("Username and password are required.");
        return;
    }

    try {
        const url = `${window.location.origin}/login`;
        console.log(`Logging in at: ${url}`);
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log("Login response:", data);
        if (!data.success) {
            alert(data.error);
            return;
        }

        user = username;
        avatar = data.avatar || getDefaultAvatar(username);
        localStorage.setItem("savedUsername", user);
        savedUsername = user;
        localStorage.setItem("sessionUser", user);
        localStorage.setItem("sessionAvatar", avatar);
        localStorage.setItem("sessionCurrentChat", currentChat);

        if (data.publicKey) {
            myPublicKeyString = data.publicKey;
            try {
                myPublicKey = await importPublicKey(myPublicKeyString);
                localStorage.setItem("sessionPublicKey", myPublicKeyString);
            } catch (err) {
                console.warn("Failed to import public key on login.", err);
            }
        }

        if (data.encryptedPrivateKey && data.privateKeySalt && data.privateKeyIv) {
            try {
                privateKey = await decryptPrivateKey(data.encryptedPrivateKey, password, data.privateKeySalt, data.privateKeyIv);
                const exportedPrivate = await exportPrivateKey(privateKey);
                localStorage.setItem("sessionPrivateKey", exportedPrivate);
            } catch (err) {
                privateKey = null;
                alert("Logged in, but secure messaging cannot be enabled. Check your password or register a new account.");
            }
        } else {
            privateKey = null;
            if (!myPublicKey) {
                alert("Logged in, but this account does not support encrypted messaging. Register a new secure account.");
            }
        }

        enterChat();
        // Preload public keys for faster messaging
        preloadAllPublicKeys();
    } catch (err) {
        console.error(err);
        alert("Login failed. Please try again.");
    }
}

window.login = login;

async function preloadAllPublicKeys() {
    try {
        const response = await fetch('/users');
        const data = await response.json();
        if (data.success) {
            for (const userData of data.users) {
                if (userData.username !== user && !publicKeys[userData.username] && !publicKeyPromises[userData.username]) {
                    prefetchPublicKey(userData.username);
                }
            }
        }
    } catch (err) {
        console.warn("Failed to preload public keys:", err);
    }
}

function logout() {
    endCall();
    clearTimeout(inactivityTimer);
    if (socket && socket.connected) {
        socket.disconnect();
    }

    localStorage.removeItem("sessionUser");
    localStorage.removeItem("sessionAvatar");
    localStorage.removeItem("sessionCurrentChat");
    localStorage.removeItem("sessionPrivateKey");
    localStorage.removeItem("sessionPublicKey");

    user = "";
    avatar = "";
    currentChat = "";
    privateKey = null;
    myPublicKey = null;
    myPublicKeyString = "";
    publicKeys = {};
    chats = {};
    onlineUsers = [];

    document.getElementById("auth").style.display = "block";
    document.getElementById("chat").style.display = "none";
    document.getElementById("messages").innerHTML = "";
    document.getElementById("user").value = localStorage.getItem("savedUsername") || "";
    document.getElementById("pass").value = "";
}

function clearChat() {
    if (!currentChat) {
        alert("Select a recipient first.");
        return;
    }
    if (!confirm("This will permanently delete all messages with " + currentChat + ". This cannot be undone. Continue?")) {
        return;
    }

    fetch("/clearMessages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, target: currentChat })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            if (chats[currentChat]) {
                chats[currentChat].messages = [];
                chats[currentChat].lastMessage = null;
            }
            document.getElementById("messages").innerHTML = "";
            socket.emit("join", user); // Reload messages
            updateChatUI();
            alert("Chat cleared successfully!");
        } else {
            alert(data.error);
        }
    })
    .catch(err => {
        console.error(err);
        alert("Failed to clear messages.");
    });
}

// Advanced clear chat with permanent deletion warning
function clearChatPermanent() {
    if (!currentChat) {
        alert("Select a recipient first.");
        return;
    }
    const warningMsg = `⚠️ PERMANENT DELETE\n\nThis will permanently delete ALL messages with ${currentChat}.\n\nThis action CANNOT BE UNDONE and will delete messages on the server.\n\nType "DELETE" to confirm:`;
    
    const confirmation = prompt(warningMsg);
    if (confirmation !== "DELETE") {
        alert("Chat deletion cancelled.");
        return;
    }

    fetch("/clearMessages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, target: currentChat })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            if (chats[currentChat]) {
                chats[currentChat].messages = [];
                chats[currentChat].lastMessage = null;
            }
            document.getElementById("messages").innerHTML = "";
            socket.emit("join", user);
            closeChatMenu();
            updateChatUI();
            alert("✓ Chat permanently deleted!");
        } else {
            alert(data.error);
        }
    })
    .catch(err => {
        console.error(err);
        alert("Failed to delete chat.");
    });
}

// Chat menu functions
function showChatMenu() {
    document.getElementById("chatMenuModal").style.display = "block";
}

function closeChatMenu() {
    document.getElementById("chatMenuModal").style.display = "none";
}

// Zoom menu functions
function toggleZoomMenu() {
    const modal = document.getElementById("zoomMenuModal");
    modal.style.display = modal.style.display === "block" ? "none" : "block";
}

function closeZoomMenu() {
    document.getElementById("zoomMenuModal").style.display = "none";
}

function increaseZoom() {
    if (currentZoom < 200) {
        currentZoom += 10;
        applyZoom();
    }
}

function decreaseZoom() {
    if (currentZoom > 50) {
        currentZoom -= 10;
        applyZoom();
    }
}

function resetZoom() {
    currentZoom = 100;
    applyZoom();
}

function applyZoom() {
    const scale = currentZoom / 100;
    const container = document.getElementById("messagesContainer") || document.getElementById("chat");
    if (container) {
        container.style.transform = `scale(${scale})`;
        container.style.transformOrigin = "top center";
    }
    document.getElementById("zoomLevel").innerText = currentZoom + "%";
    localStorage.setItem("chatZoom", currentZoom);
}

// Mute notifications
function muteNotifications() {
    const isMuted = localStorage.getItem("notificationsMuted") === "true";
    localStorage.setItem("notificationsMuted", !isMuted);
    closeChatMenu();
    alert(isMuted ? "Notifications enabled" : "Notifications muted");
}

// Auto-scroll to latest message
function autoScrollMessages() {
    const messagesContainer = document.getElementById("messagesContainer") || document.querySelector(".messages-container");
    if (messagesContainer) {
        setTimeout(() => {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 100);
    }
}

function enterChat() {
    document.getElementById("auth").style.display = "none";
    document.getElementById("chat").style.display = "flex";
    updateChatUI();
    
    // Ensure socket is connected before joining
    if (socket.connected) {
        socket.emit("join", user);
    } else {
        socket.connect();
        socket.once("connect", () => {
            socket.emit("join", user);
        });
    }
    
    addActivityListeners();
    resetInactivityTimer();
}

function showProfile() {
    const modal = document.getElementById("profileModal");
    modal.style.display = "block";
    const colorPicker = document.getElementById("chatColorPicker");
    if (colorPicker) colorPicker.value = chatBubbleColor;
}

function closeProfile() {
    const modal = document.getElementById("profileModal");
    modal.style.display = "none";
    document.getElementById("oldPass").value = "";
    document.getElementById("newUser").value = "";
    document.getElementById("newPass").value = "";
    document.getElementById("newAvatarUrl").value = "";
    const fileInput = document.getElementById("newAvatarFile");
    if (fileInput) fileInput.value = "";
}

async function updateProfile() {
    const newAvatarUrl = document.getElementById("newAvatarUrl").value.trim();
    let avatarBase64 = avatar;
    const avatarFile = document.getElementById("newAvatarFile");
    if (newAvatarUrl || (avatarFile && avatarFile.files && avatarFile.files[0])) {
        avatarBase64 = await resolveAvatarValue("newAvatarUrl", "newAvatarFile", user);
    }

    const newPassword = document.getElementById("newPass").value;
    const oldPassword = document.getElementById("oldPass").value;
    const newUsername = document.getElementById("newUser").value.trim();
    let encryptedPrivate = null;

    if (newPassword) {
        if (!privateKey) {
            alert("Cannot change password because the encrypted private key is unavailable.");
            return;
        }

        const exportedPrivate = await exportPrivateKey(privateKey);
        const privateBytes = base64ToArrayBuffer(exportedPrivate);
        encryptedPrivate = await encryptPrivateKey(privateBytes, newPassword);
    }

    // Save chat color preference
    const colorPicker = document.getElementById("chatColorPicker");
    if (colorPicker) {
        chatBubbleColor = colorPicker.value;
        localStorage.setItem("chatBubbleColor", chatBubbleColor);
    }

    const payload = {
        username: user,
        oldPassword,
        newUsername,
        newPassword,
        avatar: avatarBase64
    };

    if (encryptedPrivate) {
        payload.encryptedPrivateKey = encryptedPrivate.encrypted;
        payload.privateKeySalt = encryptedPrivate.salt;
        payload.privateKeyIv = encryptedPrivate.iv;
    }

    const response = await fetch("/updateProfile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!data.success) {
        alert(data.error);
        return;
    }

    user = data.newUsername || user;
    avatar = data.avatar || getDefaultAvatar(user);
    localStorage.setItem("savedUsername", user);
    
    // Save chat color if changed
    if (colorPicker && colorPicker.value) {
        chatBubbleColor = colorPicker.value;
        localStorage.setItem("chatBubbleColor", chatBubbleColor);
        applyChatTheme();
    }
    
    const title = document.getElementById("chatTitle");
    if (title) title.innerText = currentChat || "Select a chat";
    document.getElementById("headerAvatar").src = avatar || getDefaultAvatar(user);
    document.getElementById("user").value = user;
    updateChatUI();
    if (socket && socket.connected) {
        socket.username = user;
        socket.emit("join", user);
    }
    alert("Profile updated successfully!");
    closeProfile();
}

let allUsers = [];
let filteredUsers = [];

async function showUsersModal() {
    const modal = document.getElementById("usersModal");
    modal.style.display = "block";
    
    try {
        const response = await fetch(`${window.location.origin}/users`);
        const data = await response.json();
        
        console.log("Users endpoint response:", data);
        
        if (data.success && data.users) {
            allUsers = data.users;
            console.log("All users loaded:", allUsers);
            filteredUsers = [...allUsers];
            displayUsersList(filteredUsers);
        }
    } catch (err) {
        console.error("Failed to fetch users:", err);
        alert("Failed to load users list.");
    }
}

function closeUsersModal() {
    const modal = document.getElementById("usersModal");
    modal.style.display = "none";
    document.getElementById("usersSearchInput").value = "";
}

function filterUsersList() {
    const searchTerm = document.getElementById("usersSearchInput").value.trim().toLowerCase();
    
    if (!searchTerm) {
        filteredUsers = [...allUsers];
    } else {
        filteredUsers = allUsers.filter(u => u.username.toLowerCase().includes(searchTerm));
    }
    
    displayUsersList(filteredUsers);
}

function displayUsersList(users) {
    const usersList = document.getElementById("usersList");
    
    if (users.length === 0) {
        usersList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No users found</div>';
        return;
    }
    
    usersList.innerHTML = users.map(user => {
        const statusClass = user.isActive ? 'active' : '';
        const statusText = user.isActive ? 'Active now' : 'Offline';
        const avatar = user.avatar || getDefaultAvatar(user.username);
        
        return `
            <div class="user-item" onclick="selectUserFromList('${user.username}')">
                <img src="${avatar}" class="user-avatar" onerror="this.src='https://i.pravatar.cc/40?u=${user.username}'">
                <div class="user-info">
                    <span class="user-name">${user.username}</span>
                    <span class="user-status ${statusClass}">${statusText}</span>
                </div>
            </div>
        `;
    }).join('');
}

function selectUserFromList(username) {
    if (username === user) {
        alert("You cannot chat with yourself.");
        return;
    }
    
    currentChat = username;
    recipient = username;
    localStorage.setItem("sessionCurrentChat", currentChat);
    
    if (!chats[currentChat]) {
        chats[currentChat] = {
            messages: [],
            unreadCount: 0,
            lastMessage: null,
            avatar: getDefaultAvatar(username)
        };
    }
    
    closeUsersModal();
    updateChatUI();
    socket.emit("join", user);
    prefetchPublicKey(currentChat);
}

function setRecipient() {
    if (!currentChat) {
        alert("Choose a chat first.");
        return;
    }
    document.getElementById("messages").innerHTML = "";
    socket.emit("join", user);
}

function updateCallButtons(mode) {
    const acceptBtn = document.getElementById("acceptCallBtn");
    const declineBtn = document.getElementById("declineCallBtn");
    const endBtn = document.getElementById("endCallBtn");

    if (mode === "incoming") {
        acceptBtn.style.display = "inline-flex";
        declineBtn.style.display = "inline-flex";
        endBtn.style.display = "none";
    } else if (mode === "active") {
        acceptBtn.style.display = "none";
        declineBtn.style.display = "none";
        endBtn.style.display = "inline-flex";
    } else {
        acceptBtn.style.display = "none";
        declineBtn.style.display = "none";
        endBtn.style.display = "none";
    }
}

function updateRecordingUi(isRecording) {
    const recordBtn = document.getElementById("voiceBtn") || document.querySelector(".voice-btn");
    const preview = document.getElementById("audioPreviewContainer");
    const statusText = document.getElementById("audioStatus");

    if (recordBtn) {
        recordBtn.classList.toggle("recording", isRecording);
    }
    if (!preview || !statusText) return;

    if (isRecording) {
        statusText.innerText = "Recording...";
        preview.style.display = "flex";
    } else {
        if (recordedAudioBlob) {
            statusText.innerText = "Sending audio message...";
            preview.style.display = "flex";
        } else {
            preview.style.display = "none";
        }
    }
}

function renderOnlineUsers(list) {
    const onlineCount = document.getElementById("onlineCount");
    if (onlineCount) {
        onlineCount.innerText = list.length;
    }
    const container = document.getElementById("onlineUsersList");
    if (!container) return;
    container.innerHTML = "";
    list.forEach((username) => {
        if (username === user) return;
        const item = document.createElement("li");
        item.className = "online-user";
        item.innerText = username;
        item.onclick = () => {
            currentChat = username;
            recipient = username;
            localStorage.setItem("sessionCurrentChat", currentChat);
            const title = document.getElementById("chatTitle");
            if (title) title.innerText = currentChat;
            document.getElementById("messages").innerHTML = "";
            socket.emit("join", user);
            prefetchPublicKey(currentChat);
        };
        container.appendChild(item);
    });
}

function handleKeyPress(event) {
    if (currentChat && !publicKeys[currentChat] && !publicKeyPromises[currentChat]) {
        prefetchPublicKey(currentChat);
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        sendMsg();
        return;
    }

    if (currentChat) {
        if (!isTyping) {
            socket.emit("typing", currentChat);
            isTyping = true;
        }
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
            socket.emit("stopTyping", currentChat);
            isTyping = false;
        }, 500); // Reduced from 900 to 500ms
    }
}

async function toggleRecording() {
    if (!currentChat) {
        alert("Choose a chat before recording audio.");
        return;
    }

    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return alert("Audio recording is not supported in this browser.");
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
            const audioUrl = URL.createObjectURL(recordedAudioBlob);
            const audioPreview = document.getElementById("audioPreview");
            if (audioPreview) audioPreview.src = audioUrl;
            updateRecordingUi(false);
            stream.getTracks().forEach((track) => track.stop());
            await sendRecordedAudio();
        };

        mediaRecorder.start();
        updateRecordingUi(true);
    } catch (err) {
        console.error(err);
        alert(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Microphone access is required to record audio. Please allow access and try again."
            : "Unable to start audio recording.");
    }
}

async function startRecording() {
    if (!currentChat) {
        alert("Choose a chat before recording audio.");
        return;
    }

    if (mediaRecorder && mediaRecorder.state === "recording") {
        return; // Already recording
    }

    // Reset pending flags
    pendingStopRecording = false;
    shouldAutoSendRecording = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Audio recording is not supported in this browser.");
        return;
    }

    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(recordingStream);
        shouldAutoSendRecording = false;

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
            const audioUrl = URL.createObjectURL(recordedAudioBlob);
            const audioPreview = document.getElementById("audioPreview");
            if (audioPreview) audioPreview.src = audioUrl;
            updateRecordingUi(false);
            recordingStream.getTracks().forEach((track) => track.stop());
            
            if (shouldAutoSendRecording) {
                shouldAutoSendRecording = false;
                // Small delay to ensure blob is ready
                setTimeout(async () => {
                    if (recordedAudioBlob && currentChat) {
                        try {
                            const recipientPublicKey = await getPublicKeyFor(currentChat);
                            const base64Audio = await blobToBase64(recordedAudioBlob);
                            const encrypted = await encryptMessage(base64Audio, recipientPublicKey, myPublicKey, currentChat);
                            const tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                            
                            sendEncryptedMessage({
                                to: currentChat,
                                type: "audio",
                                ciphertext: encrypted.ciphertext,
                                iv: encrypted.iv,
                                encryptedKeys: encrypted.encryptedKeys,
                                tempId
                            }, tempId);
                            
                            clearRecording();
                        } catch (err) {
                            console.error("Error sending recorded audio:", err);
                        }
                    }
                }, 50);
            }
        };

        mediaRecorder.start();
        updateRecordingUi(true);
        
        // Handle pending stop if user released button before recording started
        if (pendingStopRecording) {
            pendingStopRecording = false;
            shouldAutoSendRecording = true;
            mediaRecorder.stop();
        }
    } catch (err) {
        console.error(err);
        alert(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Microphone access is required to record audio. Please allow access and try again."
            : "Unable to start audio recording.");
    }
}

async function stopAndSendRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        shouldAutoSendRecording = true;
        mediaRecorder.stop();
    } else {
        // Recorder not started yet, set pending flags
        pendingStopRecording = true;
        shouldAutoSendRecording = true;
    }
}

async function beginRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Audio recording is not supported in this browser.");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
            const audioUrl = URL.createObjectURL(recordedAudioBlob);
            const audioPreview = document.getElementById("audioPreview");
            audioPreview.src = audioUrl;
            updateRecordingUi(false);
            stream.getTracks().forEach((track) => track.stop());
            if (!recordingCancelled) {
                await sendRecordedAudio();
            } else {
                clearRecording();
            }
        };

        mediaRecorder.start();
        updateRecordingUi(true);
        if (pendingStopRecording && mediaRecorder.state === "recording") {
            pendingStopRecording = false;
            mediaRecorder.stop();
        }
    } catch (err) {
        console.error(err);
        isRecordingHold = false;
        recordingCancelled = false;
        pendingStopRecording = false;
        updateRecordingUi(false);
        const recordBtn = document.getElementById("voiceBtn") || document.querySelector(".voice-btn");
        if (recordBtn) recordBtn.innerHTML = '<i class="fas fa-microphone"></i>';
        alert(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Microphone access is required to record audio. Please allow access and try again."
            : "Unable to start audio recording.");
    }
}

function clearRecording() {
    recordedAudioBlob = null;
    const audioPreview = document.getElementById("audioPreview");
    audioPreview.src = "";
    updateRecordingUi(false);
}

async function sendAudioMsg() {
    if (!currentChat) {
        alert("Choose a recipient before sending an audio message.");
        return;
    }
    if (!recordedAudioBlob) {
        alert("Record an audio clip first.");
        return;
    }
    if (!privateKey || !myPublicKey) {
        alert("Secure messaging is unavailable because the account keys are missing.");
        return;
    }

    try {
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        const base64Audio = await blobToBase64(recordedAudioBlob);
        const encrypted = await encryptMessage(base64Audio, recipientPublicKey, myPublicKey, currentChat);
        const tempId = Date.now().toString();
        const localMessage = {
            from: user,
            to: currentChat,
            type: "audio",
            audioBase64: base64Audio,
            tempId,
            status: "sending",
            avatar,
            time: new Date().toISOString()
        };
        if (!chats[currentChat]) {
            chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
        }
        chats[currentChat].messages.push(localMessage);
        if (currentChat === localMessage.to) {
            addMessage(localMessage);
            updateChatUI();
            autoScrollMessages();
        }

        sendEncryptedMessage({
            to: currentChat,
            type: "audio",
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId
        }, tempId);

        clearRecording();
        document.getElementById("msg").value = "";
    } catch (err) {
        console.error(err);
        alert(err.message || "Unable to send audio message.");
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

let encryptionWorker = null;

function getEncryptionWorker() {
    if (!encryptionWorker) {
        encryptionWorker = new Worker('encrypt-worker.js');
    }
    return encryptionWorker;
}

async function sendMsg() {
    if (isSending) return; // Prevent multiple sends
    if (!socket.connected) {
        alert("Not connected to server. Please refresh the page or access at http://localhost:3000");
        return;
    }
    const msg = document.getElementById("msg").value.trim();
    if (!msg) return;
    if (!currentChat) {
        alert("Choose a user to chat with first.");
        return;
    }
    if (!privateKey || !myPublicKey) {
        alert("Secure messaging is unavailable because the account keys are missing.");
        return;
    }

    console.log("Sending message:", msg, "to", currentChat);
    isSending = true;

    const tempId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const localMessage = {
        from: user,
        to: currentChat,
        msg,
        type: "text",
        tempId,
        status: "sending",
        avatar,
        time: new Date().toISOString(),
        replyTo: currentReply ? {
            id: currentReply.messageId,
            from: currentReply.replyToUser,
            text: currentReply.replyToText
        } : null
    };

    if (!chats[currentChat]) {
        chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
    }
    chats[currentChat].messages.push(localMessage);
    if (currentChat === localMessage.to) {
        addMessage(localMessage);
        updateChatUI();
        autoScrollMessages();
    }

    // Clear input immediately for fast typing
    document.getElementById("msg").value = "";
    cancelReply();
    socket.emit("stopTyping", currentChat);

    try {
        const recipientPublicKey = await getPublicKeyFor(currentChat);
        console.log("Recipient public key obtained, encrypting message...");
        const encrypted = await encryptMessage(msg, recipientPublicKey, myPublicKey, currentChat);
        const messagePayload = {
            to: currentChat,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            encryptedKeys: encrypted.encryptedKeys,
            tempId,
            type: "text"
        };
        if (localMessage.replyTo) {
            messagePayload.replyTo = localMessage.replyTo;
        }
        console.log("Sending encrypted message to server...");
        sendEncryptedMessage(messagePayload, tempId);
    } catch (err) {
        console.error("Encryption/send error:", err);
        console.warn(`Unable to send message ${tempId} right now. It will remain in sending state.`);
        alert(err.message || "Unable to send encrypted message.");
        updateMessageStatus(tempId, "failed");
    } finally {
        isSending = false;
    }
}

socket.on("loadMessages", async (msgs) => {
    // Reset chat state before loading new messages to prevent duplicates
    chats = {};

    // Load and decrypt messages into chats data structure
    for (const msg of msgs) {
        const chatUser = msg.from === user ? msg.to : msg.from;
        if (!chats[chatUser]) {
            chats[chatUser] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(chatUser) };
        }
        const decrypted = await tryDecryptMessage(msg);
        if (decrypted.from === user) {
            decrypted.status = decrypted.read ? "seen" : "sent";
        }
        chats[chatUser].messages.push(decrypted);
        if (!chats[chatUser].lastMessage || new Date(decrypted.time) > new Date(chats[chatUser].lastMessage.time)) {
            chats[chatUser].lastMessage = decrypted;
        }
    }

    if (currentChat && !chats[currentChat]) {
        chats[currentChat] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(currentChat) };
    }

    Object.values(chats).forEach(chat => {
        chat.messages.sort((a, b) => new Date(a.time) - new Date(b.time));
    });

    // If we have a current chat, display its messages
    if (currentChat) {
        document.getElementById("messages").innerHTML = "";
        if (chats[currentChat]) {
            for (const message of chats[currentChat].messages) {
                addMessage(message);
            }
        }
        updateChatUI();
        autoScrollMessages();
    }
});

socket.on("message", async (data) => {
    console.log("Received message from server:", data);
    const chatUser = data.from === user ? data.to : data.from;
    if (!chats[chatUser]) {
        chats[chatUser] = { messages: [], unreadCount: 0, lastMessage: null, avatar: getDefaultAvatar(chatUser) };
    }

    const decrypted = await tryDecryptMessage(data);
    if (decrypted) {
        if (decrypted.from === user) {
            decrypted.status = decrypted.read ? "seen" : "sent";
        }
        const existingMessage = getMessageById(chatUser, decrypted.id) || getMessageById(chatUser, decrypted.tempId);
        if (existingMessage) {
            Object.assign(existingMessage, decrypted, { status: "sent" });
            const existingMessageId = existingMessage.tempId || existingMessage.id;
            if (chatUser === currentChat) {
                updateMessageStatus(existingMessageId, "sent");
            }
        } else {
            chats[chatUser].messages.push(decrypted);
            if (chatUser === currentChat && decrypted.tempId) {
                updateMessageStatus(decrypted.tempId, "sent");
            }
        }
        chats[chatUser].lastMessage = decrypted;

        if (chatUser !== currentChat) {
            chats[chatUser].unreadCount++;
            updateChatUI();
        }
        if (chatUser === currentChat) {
            if (!existingMessage) {
                addMessage(decrypted);
            }
            autoScrollMessages();
        }
    }
});

socket.on("onlineUsers", (list) => {
    onlineUsers = list;
    updateChatUI(false);
    if (currentChat) {
        prefetchPublicKey(currentChat);
        if (onlineUsers.includes(currentChat)) {
            document.getElementById("chatSubtitle").innerText = "Active now";
        } else {
            document.getElementById("chatSubtitle").innerText = "Offline";
        }
    }
});

socket.on("typing", (userTyping) => {
    if (userTyping !== user && userTyping === currentChat) {
        document.getElementById("typingIndicator").style.display = "block";
        document.getElementById("typingText").innerText = `${userTyping} is typing...`;
    }
});

socket.on("stopTyping", () => {
    document.getElementById("typingIndicator").style.display = "none";
});

socket.on("messageRead", (data) => {
    const { messageId, readBy } = data;
    // Update message status in UI - change to "seen"
    updateMessageStatus(messageId, "seen");
    
    // Update in chats data
    for (const chatUser in chats) {
        const message = chats[chatUser].messages.find(m => m.id === messageId);
        if (message) {
            message.read = true;
            message.readAt = new Date().toISOString();
            break;
        }
    }
});

socket.on("messageEdited", (data) => {
    // Update in chats data
    Object.keys(chats).forEach(chatUser => {
        const msgIndex = chats[chatUser].messages.findIndex(m => m.id === data.id);
        if (msgIndex !== -1) {
            chats[chatUser].messages[msgIndex].msg = data.newText;
            chats[chatUser].messages[msgIndex].edited = true;
            chats[chatUser].messages[msgIndex].editedAt = data.editedAt;
        }
    });

    // Update UI if message is visible
    const messageDiv = document.querySelector(`[data-id="${data.id}"]`);
    if (messageDiv) {
        const contentDiv = messageDiv.querySelector('.message-content');
        if (contentDiv) {
            contentDiv.innerHTML = `${data.newText} <span class="edited">(edited)</span>`;
        }
    }
});

socket.on("messageDeleted", (data) => {
    // Update in chats data
    Object.keys(chats).forEach(chatUser => {
        chats[chatUser].messages = chats[chatUser].messages.filter(m => m.id !== data.id);
        if (chats[chatUser].lastMessage && chats[chatUser].lastMessage.id === data.id) {
            chats[chatUser].lastMessage = chats[chatUser].messages[chats[chatUser].messages.length - 1] || null;
        }
    });

    // Update UI
    const messageDiv = document.querySelector(`[data-id="${data.id}"]`);
    if (messageDiv) {
        messageDiv.remove();
    }
    updateChatUI();
});

socket.on("addReaction", (data) => {
    if (!messageReactions[data.messageId]) {
        messageReactions[data.messageId] = {};
    }
    if (!messageReactions[data.messageId][data.emoji]) {
        messageReactions[data.messageId][data.emoji] = [];
    }
    if (!messageReactions[data.messageId][data.emoji].includes(data.from)) {
        messageReactions[data.messageId][data.emoji].push(data.from);
        updateMessageReactions(data.messageId);
    }
});

function isMessageVisible(message) {
    if (!message.from || !message.to) return false;
    if (message.from !== user && message.to !== user) return false;
    if (!recipient) return true;
    return message.from === recipient || message.to === recipient;
}

async function tryDecryptMessage(message) {
    // Handle old format messages (unencrypted)
    if (message.msg && !message.ciphertext) {
        return {
            from: message.user || message.from,
            to: message.to || "",
            msg: message.msg,
            avatar: message.avatar || "",
            time: message.time,
            type: "text"
        };
    }

    if (message.audioBase64 || message.imageData || message.videoData || message.fileData) {
        return message;
    }

    if (message.msg && message.type !== "audio" && message.type !== "image" && message.type !== "video" && message.type !== "file") {
        return message;
    }

    if (!message.encryptedKeys || !message.encryptedKeys[user]) {
        return {
            ...message,
            msg: "[Encrypted message cannot be decrypted]"
        };
    }

    try {
        const plaintext = await decryptMessage(message);
        if (message.type === "audio") {
            return { ...message, audioBase64: plaintext };
        } else if (message.type === "image") {
            if (plaintext.startsWith("data:")) {
                return { ...message, imageData: plaintext };
            }
            return { ...message, imageData: `data:image/jpeg;base64,${plaintext}` };
        } else if (message.type === "video") {
            if (plaintext.startsWith("data:")) {
                return { ...message, videoData: plaintext };
            }
            return { ...message, videoData: `data:video/mp4;base64,${plaintext}` };
        } else if (message.type === "file") {
            const fileData = JSON.parse(plaintext);
            return { ...message, fileData };
        }
        return { ...message, msg: plaintext };
    } catch (err) {
        console.error("Decrypt failed", err);
        return { ...message, msg: "[Cannot decrypt message]" };
    }
}

function processMentions(text) {
    return text.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
}

function setReplyContext(message) {
    const replyText = message.msg || (message.type ? `[${message.type}]` : "[message]");
    currentReply = {
        messageId: message.id || message.tempId || Date.now().toString(),
        replyToUser: message.from || "",
        replyToText: replyText.length > 80 ? replyText.slice(0, 77) + "..." : replyText
    };
    renderReplyPreview();
}

function cancelReply() {
    currentReply = null;
    renderReplyPreview();
}

function renderReplyPreview() {
    const preview = document.getElementById("replyPreview");
    if (!preview) return;
    if (currentReply) {
        preview.innerHTML = `<span>Replying to <strong>@${currentReply.replyToUser}</strong>: "${currentReply.replyToText}"</span><button class="cancel-reply-btn" onclick="cancelReply()">×</button>`;
        preview.style.display = "flex";
    } else {
        preview.innerHTML = "";
        preview.style.display = "none";
    }
}

function getMessageById(chatUser, messageId) {
    if (!chats[chatUser] || !chats[chatUser].messages) return null;
    return chats[chatUser].messages.find(m => (m.id || m.tempId || "") === messageId) || null;
}

function replyToMessage(messageId) {
    if (!currentChat) return;
    const message = getMessageById(currentChat, messageId);
    if (!message) return;
    setReplyContext(message);
}

function addMessage(data) {
    console.log("Adding message to DOM:", data.msg || data.type || "unknown");
    const div = document.createElement("div");
    const isMe = data.from === user;
    div.className = "msg " + (isMe ? "me" : "other");
    const msgId = data.tempId || data.id || Date.now();
    div.setAttribute("data-id", msgId);
    div.setAttribute("data-status", data.status || "sending");

    let contentHtml = "";
    let messageId = data.id || data.tempId || Date.now();

    if (data.type === "image") {
        if (data.imageData) {
            contentHtml = `<img src="${data.imageData}" class="message-image" onclick="openImageModal('${data.imageData}')">`;
        } else {
            contentHtml = `<div>[Image could not be loaded]</div>`;
        }
    } else if (data.type === "video") {
        if (data.videoData) {
            contentHtml = `<video controls src="${data.videoData}" class="message-video"></video>`;
        } else {
            contentHtml = `<div>[Video could not be loaded]</div>`;
        }
    } else if (data.type === "file") {
        if (data.fileData) {
            contentHtml = `<div class="file-message">
                <i class="fas fa-file"></i>
                <div>
                    <div class="file-name">${data.fileData.name}</div>
                    <div class="file-size">${formatFileSize(data.fileData.size)}</div>
                </div>
                <button onclick="downloadFile('${data.fileData.data}', '${data.fileData.name}')" class="download-btn">Download</button>
            </div>`;
        } else {
            contentHtml = `<div>[File could not be loaded]</div>`;
        }
    } else if (data.type === "audio") {
        if (data.audioBase64) {
            const audioSrc = `data:audio/webm;base64,${data.audioBase64}`;
            const audioPlayerId = `audio-player-${messageId}`;
            contentHtml = `
                <div class="audio-player" id="${audioPlayerId}">
                    <button class="audio-play-btn" type="button" onclick="toggleAudio('${audioPlayerId}')">
                        <i class="fas fa-play"></i>
                    </button>
                    <div class="audio-waveform">
                        <span class="audio-wave"></span>
                        <span class="audio-wave"></span>
                        <span class="audio-wave"></span>
                        <span class="audio-wave"></span>
                        <span class="audio-wave"></span>
                    </div>
                    <div class="audio-meta">
                        <div class="audio-progress-bar"><div class="audio-progress"></div></div>
                        <div class="audio-duration" id="${audioPlayerId}-duration">00:00</div>
                    </div>
                    <audio id="${audioPlayerId}-source" class="audio-source" src="${audioSrc}"></audio>
                </div>`;
        } else {
            contentHtml = `<div>[Audio message could not be loaded]</div>`;
        }
    } else {
        let msgText = data.msg || "[No message]";
        if (data.edited) {
            msgText += ' <span class="edited">(edited)</span>';
        }
        msgText = processMentions(msgText);
        contentHtml = `<div class="message-content">${msgText}</div>`;
    }

    const replyHtml = data.replyTo ? `<div class="message-reply-preview">Replying to <strong>@${data.replyTo.from}</strong>: ${processMentions(data.replyTo.text)}</div>` : "";
    const time = data.time ? new Date(data.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const statusClass = data.status || "sending";
    const statusIndicator = isMe ? `<div class="message-status" data-status="${statusClass}">${getMessageStatusHtml(statusClass)}</div>` : '';

    div.innerHTML = `
        ${!isMe ? '<img src="' + (data.avatar || getDefaultAvatar(data.from)) + '" class="avatar">' : ''}
        <div class="bubble">
            ${replyHtml}
            ${contentHtml}
            <div class="message-time">${time}</div>
            ${statusIndicator}
            <div class="message-actions">
                <button class="action-btn" onclick="showReactionModal('${messageId}')">😀</button>
                <button class="action-btn" onclick="replyToMessage('${messageId}')">Reply</button>
                ${isMe && data.type === "text" ? '<button class="action-btn" onclick="editMessage(\'' + messageId + '\')">Edit</button>' : ''}
                ${isMe ? '<button class="action-btn" onclick="unsendMessage(\'' + messageId + '\')">Delete</button>' : ''}
            </div>
            <div class="reactions"></div>
        </div>
        ${isMe ? '<img src="' + avatar + '" class="avatar">' : ''}
    `;

    console.log("Message div created with id:", msgId, "content preview:", contentHtml.substring(0, 50));
    document.getElementById("messages").appendChild(div);
    console.log("Message appended, total messages in DOM:", document.getElementById("messages").childElementCount);
    updateMessageReactions(messageId);
    document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
    initializeAudioPlayer(messageId);

    // Send read receipt for incoming messages
    if (!isMe && data.from && data.id) {
        socket.emit("messageRead", { messageId: data.id, from: data.from });
    }
}

function initializeAudioPlayer(messageId) {
    const playerId = `audio-player-${messageId}`;
    const player = document.getElementById(playerId);
    if (!player) return;

    const audioEl = document.getElementById(`${playerId}-source`);
    const progressBar = player.querySelector('.audio-progress');
    const durationLabel = document.getElementById(`${playerId}-duration`);
    const playIcon = player.querySelector('.audio-play-btn i');

    if (!audioEl || !progressBar || !durationLabel || !playIcon) return;

    audioEl.addEventListener('loadedmetadata', () => {
        durationLabel.textContent = formatTime(audioEl.duration);
    });

    audioEl.addEventListener('timeupdate', () => {
        const progress = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
        progressBar.style.width = `${progress}%`;
        durationLabel.textContent = formatTime(audioEl.currentTime);
    });

    audioEl.addEventListener('ended', () => {
        playIcon.className = 'fas fa-play';
        progressBar.style.width = '0%';
        durationLabel.textContent = formatTime(audioEl.duration);
    });
}

function toggleAudio(playerId) {
    const player = document.getElementById(playerId);
    if (!player) return;

    const audioEl = document.getElementById(`${playerId}-source`);
    const playIcon = player.querySelector('.audio-play-btn i');
    if (!audioEl || !playIcon) return;

    document.querySelectorAll('.audio-source').forEach((audio) => {
        if (audio.id !== `${playerId}-source`) {
            audio.pause();
            const otherPlayIcon = document.querySelector(`#${audio.id.replace('-source', '')} .audio-play-btn i`);
            if (otherPlayIcon) otherPlayIcon.className = 'fas fa-play';
        }
    });

    if (audioEl.paused) {
        audioEl.play().catch(() => {});
        playIcon.className = 'fas fa-pause';
    } else {
        audioEl.pause();
        playIcon.className = 'fas fa-play';
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Update message status (sending → sent → seen)
function getMessageStatusHtml(status) {
    const labels = {
        sending: "Sending",
        sent: "Sent",
        seen: "Seen",
        failed: "Failed"
    };
    const icons = {
        sending: "fa-paper-plane",
        sent: "fa-check",
        seen: "fa-check-double",
        failed: "fa-exclamation-circle"
    };
    return `<i class="fas ${icons[status] || "fa-paper-plane"}"></i><span>${labels[status] || "Sending"}</span>`;
}

function updateMessageStatus(msgId, status) {
    let msgEl = document.querySelector(`[data-id="${msgId}"]`);
    if (!msgEl) {
        msgEl = Array.from(document.querySelectorAll('[data-id]')).find(el => {
            const elementId = el.getAttribute('data-id');
            return elementId === msgId;
        }) || null;
    }
    if (msgEl) {
        msgEl.setAttribute("data-status", status);
        const statusDiv = msgEl.querySelector(".message-status");
        if (statusDiv) {
            statusDiv.setAttribute("data-status", status);
            statusDiv.innerHTML = getMessageStatusHtml(status);
        }
    }
    for (const chatUser in chats) {
        const message = getMessageById(chatUser, msgId);
        if (message) {
            message.status = status;
            break;
        }
    }
}

function sendEncryptedMessage(payload, tempId, retryCount = 0) {
    if (!socket.connected) {
        enqueuePendingMessage(payload, tempId, retryCount);
        console.warn(`Socket disconnected, queued message ${tempId} for later delivery.`);
        return;
    }

    const ackTimeout = setTimeout(() => {
        console.warn(`Still waiting for server ack for message ${tempId}. Keeping it in sending state.`);
    }, 2000); // Reduced from 7000 to 2000ms

    socket.emit("message", payload, (ack) => {
        clearTimeout(ackTimeout);
        if (ack && ack.success) {
            updateMessageStatus(tempId, "sent");
        } else if (ack && !ack.success) {
            if (retryCount < 2) {
                console.warn(`Retrying message ${tempId} after transient error:`, ack.error || ack);
                setTimeout(() => sendEncryptedMessage(payload, tempId, retryCount + 1), 500); // Reduced from 1200 to 500ms
            } else {
                console.error(`Message ${tempId} failed after retries:`, ack.error || ack);
                console.warn(`Message ${tempId} will remain in sending state until server confirmation.`);
            }
        } else {
            console.warn(`No ack payload received for ${tempId}. Message remains sending until confirmation.`);
        }
    });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function downloadFile(dataUrl, fileName) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function openImageModal(imageSrc) {
    // TODO: Implement image modal
    window.open(imageSrc, '_blank');
}

function processMentions(text) {
    return text.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
}

function editMessage(messageId) {
    const messageDiv = document.querySelector(`[data-id="${messageId}"]`);
    if (!messageDiv) return;

    const bubble = messageDiv.querySelector('.bubble');
    const contentDiv = bubble.querySelector('.message-content');
    if (!contentDiv) return;

    const originalText = contentDiv.innerText.replace('(edited)', '').trim();

    contentDiv.innerHTML = `
        <input type="text" value="${originalText}" class="edit-input" id="editInput">
        <button onclick="saveEdit('${messageId}')" class="save-edit-btn">Save</button>
        <button onclick="cancelEdit()" class="cancel-edit-btn">Cancel</button>
    `;

    editingMessageId = messageId;
    document.getElementById('editInput').focus();
}

function saveEdit(messageId) {
    const newText = document.getElementById('editInput').value.trim();
    if (!newText) return;

    socket.emit("editMessage", { id: messageId, newText });
    cancelEdit();
}

function cancelEdit() {
    if (editingMessageId) {
        socket.emit("join", user); // Reload messages
        editingMessageId = null;
    }
}

function unsendMessage(messageId) {
    if (!confirm("Unsend this message? This cannot be undone.")) {
        return;
    }
    socket.emit("deleteMessage", { id: messageId });
    const messageDiv = document.querySelector(`[data-id="${messageId}"]`);
    if (messageDiv) {
        const bubble = messageDiv.querySelector('.bubble');
        if (bubble) {
            bubble.innerHTML = `<div class="deleted-message">This message was unsent.</div>`;
        }
    }
}

function randomBytes(length) {
    return window.crypto.getRandomValues(new Uint8Array(length));
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

async function deriveAesKey(password, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 250000,
            hash: "SHA-256"
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptPrivateKey(privateKeyBytes, password) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const aesKey = await deriveAesKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        privateKeyBytes
    );
    return {
        encrypted: arrayBufferToBase64(ciphertext),
        salt: arrayBufferToBase64(salt),
        iv: arrayBufferToBase64(iv)
    };
}

async function decryptPrivateKey(encryptedBase64, password, saltBase64, ivBase64) {
    const salt = base64ToArrayBuffer(saltBase64);
    const iv = base64ToArrayBuffer(ivBase64);
    const ciphertext = base64ToArrayBuffer(encryptedBase64);
    const aesKey = await deriveAesKey(password, salt);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        aesKey,
        ciphertext
    );
    return importPrivateKey(arrayBufferToBase64(decrypted));
}

async function exportPublicKey(key) {
    const spki = await crypto.subtle.exportKey("spki", key);
    return arrayBufferToBase64(spki);
}

async function exportPrivateKey(key) {
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
    return arrayBufferToBase64(pkcs8);
}

async function importPublicKey(base64) {
    return crypto.subtle.importKey(
        "spki",
        base64ToArrayBuffer(base64),
        { name: "RSA-OAEP", hash: "SHA-256" },
        true,
        ["encrypt"]
    );
}

async function importPrivateKey(base64) {
    return crypto.subtle.importKey(
        "pkcs8",
        base64ToArrayBuffer(base64),
        { name: "RSA-OAEP", hash: "SHA-256" },
        true,
        ["decrypt"]
    );
}

async function getPublicKeyFor(username) {
    if (publicKeys[username]) {
        return publicKeys[username];
    }
    if (publicKeyPromises[username]) {
        return publicKeyPromises[username];
    }

    publicKeyPromises[username] = (async () => {
        const response = await fetch(`/publicKey/${encodeURIComponent(username)}`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || "Unable to fetch public key");
        }
        const imported = await importPublicKey(data.publicKey);
        publicKeys[username] = imported;
        delete publicKeyPromises[username];
        return imported;
    })();

    return publicKeyPromises[username];
}

function prefetchPublicKey(username) {
    if (!username || username === user) return;
    if (publicKeys[username] || publicKeyPromises[username]) return;
    getPublicKeyFor(username).catch(() => {
        // Ignore fetch errors for now; public key will be loaded on demand.
    });
}

async function encryptMessage(plaintext, recipientPublicKey, senderPublicKey, recipientUsername) {
    const aesKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    const iv = randomBytes(12);
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoded);
    const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);

    const encryptedKeys = {};
    encryptedKeys[recipientUsername] = arrayBufferToBase64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPublicKey, rawAesKey));
    encryptedKeys[user] = arrayBufferToBase64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, senderPublicKey, rawAesKey));

    return {
        ciphertext: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv),
        encryptedKeys
    };
}

async function decryptMessage(message) {
    const encryptedKeyBase64 = message.encryptedKeys[user];
    if (!encryptedKeyBase64) throw new Error("Missing decryption key");

    const encryptedKey = base64ToArrayBuffer(encryptedKeyBase64);
    const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedKey);
    const aesKey = await crypto.subtle.importKey("raw", rawAesKey, "AES-GCM", false, ["decrypt"]);
    const iv = base64ToArrayBuffer(message.iv);
    const ciphertext = base64ToArrayBuffer(message.ciphertext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, aesKey, ciphertext);
    return new TextDecoder().decode(decrypted);
}

function toBase64(file) {
    return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => res(reader.result);
        reader.onerror = err => rej(err);
    });
}

async function startAudioCall() {
    if (!user) {
        alert("Login first to start a voice call.");
        return;
    }
    if (currentCallTarget) {
        alert("A call is already in progress.");
        return;
    }

    const selectedUser = currentChat;
    if (!selectedUser) {
        alert("Select a chat first.");
        return;
    }
    if (selectedUser === user) {
        alert("You cannot call yourself.");
        return;
    }

    currentCallTarget = selectedUser;
    document.getElementById("callModal").style.display = "block";
    document.getElementById("callUser").innerText = selectedUser;
    document.getElementById("callAvatar").src = chats[selectedUser]?.avatar || getDefaultAvatar(selectedUser);
    document.getElementById("callStatus").innerText = "Calling " + selectedUser + "...";
    updateCallButtons("active");

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        peerConnection = new RTCPeerConnection();

        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
        peerConnection.ontrack = (event) => {
            if (remoteAudio) {
                remoteAudio.srcObject = event.streams[0];
            }
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
            }
        };
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("iceCandidate", { candidate: event.candidate, to: selectedUser });
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("callUser", { offer, to: selectedUser });
    } catch (err) {
        console.error(err);
        alert(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Microphone access is required for voice calls. Please allow access and try again."
            : "Unable to start the voice call. Please try again.");
        endCall();
    }
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    document.getElementById("callModal").style.display = "none";
    updateCallButtons("none");
    if (currentCallTarget) {
        socket.emit("endCall", { to: currentCallTarget });
    }
    currentCallTarget = "";
    incomingCall = false;
    pendingOffer = null;
}

async function acceptCall() {
    if (!incomingCall || !pendingOffer || !currentCallTarget) return;

    document.getElementById("callStatus").innerText = "Connecting to " + currentCallTarget + "...";
    updateCallButtons("active");
    incomingCall = false;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        peerConnection = new RTCPeerConnection();

        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
        peerConnection.ontrack = (event) => {
            if (remoteAudio) {
                remoteAudio.srcObject = event.streams[0];
            }
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
            }
        };
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("iceCandidate", { candidate: event.candidate, to: currentCallTarget });
            }
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("answerCall", { answer, to: currentCallTarget });
    } catch (err) {
        console.error(err);
        endCall();
    }
}

function declineCall() {
    if (currentCallTarget) {
        socket.emit("endCall", { to: currentCallTarget });
    }
    document.getElementById("callModal").style.display = "none";
    updateCallButtons("none");
    currentCallTarget = "";
    incomingCall = false;
    pendingOffer = null;
}

socket.on("callMade", async (data) => {
    currentCallTarget = data.from;
    pendingOffer = data.offer;
    incomingCall = true;
    document.getElementById("callModal").style.display = "block";
    document.getElementById("callStatus").innerText = "Incoming call from " + data.from;
    updateCallButtons("incoming");
});

socket.on("callAnswered", async (data) => {
    document.getElementById("callStatus").innerText = "Connected";
    updateCallButtons("active");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on("iceCandidate", (data) => {
    if (peerConnection) {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
});

socket.on("callEnded", (data) => {
    if (currentCallTarget === data.from) {
        endCall();
        alert("Call ended by " + data.from);
    }
});

// Initialize theme on load
initTheme();