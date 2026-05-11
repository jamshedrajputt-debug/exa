// Web Worker for encrypting messages
self.onmessage = async function(e) {
    const { msg, recipientPublicKey, myPublicKey, currentChat } = e.data;

    try {
        // Import the encryption functions (we need to duplicate them here)
        async function encryptMessage(msg, recipientPublicKey, myPublicKey, currentChat) {
            const encoder = new TextEncoder();
            const data = encoder.encode(msg);

            // Generate a random AES key
            const aesKey = await crypto.subtle.generateKey(
                { name: "AES-GCM", length: 256 },
                true,
                ["encrypt"]
            );

            // Generate a random IV
            const iv = crypto.getRandomValues(new Uint8Array(12));

            // Encrypt the message with AES
            const ciphertext = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                aesKey,
                data
            );

            // Export the AES key
            const exportedAesKey = await crypto.subtle.exportKey("raw", aesKey);

            // Encrypt the AES key with the recipient's public key
            const encryptedAesKeyForRecipient = await crypto.subtle.encrypt(
                { name: "RSA-OAEP" },
                recipientPublicKey,
                exportedAesKey
            );

            // Encrypt the AES key with the sender's public key (for later decryption)
            const encryptedAesKeyForSender = await crypto.subtle.encrypt(
                { name: "RSA-OAEP" },
                myPublicKey,
                exportedAesKey
            );

            return {
                ciphertext: arrayBufferToBase64(ciphertext),
                iv: arrayBufferToBase64(iv),
                encryptedKeys: {
                    [currentChat]: arrayBufferToBase64(encryptedAesKeyForRecipient),
                    sender: arrayBufferToBase64(encryptedAesKeyForSender)
                }
            };
        }

        function arrayBufferToBase64(buffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }

        const result = await encryptMessage(msg, recipientPublicKey, myPublicKey, currentChat);
        self.postMessage({ success: true, result });
    } catch (error) {
        self.postMessage({ success: false, error: error.message });
    }
};