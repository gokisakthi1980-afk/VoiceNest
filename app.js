import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, collection, query, onSnapshot } from 'firebase/firestore';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// A placeholder for the Gemini API key, which will be provided by the environment
const apiKey = "";

// Firebase configuration variables, also provided by the environment
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : undefined;

const APP_NAME = "SpeechBuddy";

// A utility function to convert PCM audio data to a WAV Blob
const pcmToWav = (pcmData, sampleRate) => {
    const dataView = new DataView(new ArrayBuffer(44 + pcmData.byteLength));
    let offset = 0;

    // WAV header
    const writeString = (str) => {
        for (let i = 0; i < str.length; i++) {
            dataView.setUint8(offset++, str.charCodeAt(i));
        }
    };
    const writeUint32 = (val) => {
        dataView.setUint32(offset, val, true);
        offset += 4;
    };
    const writeUint16 = (val) => {
        dataView.setUint16(offset, val, true);
        offset += 2;
    };

    writeString('RIFF');
    writeUint32(36 + pcmData.byteLength);
    writeString('WAVE');
    writeString('fmt ');
    writeUint32(16);
    writeUint16(1);
    writeUint16(1);
    writeUint32(sampleRate);
    writeUint32(sampleRate * 2);
    writeUint16(2);
    writeUint16(16);
    writeString('data');
    writeUint32(pcmData.byteLength);

    const pcmDataView = new DataView(pcmData.buffer);
    for (let i = 0; i < pcmData.byteLength; i++) {
        dataView.setUint8(offset++, pcmDataView.getUint8(i));
    }

    return new Blob([dataView], { type: 'audio/wav' });
};

// A utility function to handle exponential backoff for API calls
const withExponentialBackoff = async (apiCall) => {
    const maxRetries = 5;
    let retries = 0;
    let delay = 1000;

    while (true) {
        try {
            return await apiCall();
        } catch (error) {
            if (retries < maxRetries && error.status >= 500) {
                console.warn(`API call failed, retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                retries++;
            } else {
                throw error;
            }
        }
    }
};

const App = () => {
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [phase, setPhase] = useState('start');
    const [userText, setUserText] = useState('');
    const [correctedText, setCorrectedText] = useState('');
    const [audioUrl, setAudioUrl] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [isCorrecting, setIsCorrecting] = useState(false);
    const [history, setHistory] = useState([]);
    const audioRef = useRef(null);

    // Initialize Firebase and set up authentication
    useEffect(() => {
        const initializeFirebase = async () => {
            try {
                const app = initializeApp(firebaseConfig);
                const auth = getAuth(app);
                const firestore = getFirestore(app);
                setDb(firestore);

                onAuthStateChanged(auth, async (user) => {
                    if (user) {
                        setUserId(user.uid);
                    } else {
                        const anonymousUser = await signInAnonymously(auth);
                        setUserId(anonymousUser.user.uid);
                    }
                    setIsAuthReady(true);
                });

                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                }
            } catch (error) {
                console.error("Firebase initialization failed:", error);
            }
        };

        if (Object.keys(firebaseConfig).length > 0) {
            initializeFirebase();
        } else {
            // Fallback for when Firebase isn't needed or configured
            setIsAuthReady(true);
        }
    }, []);

    // Load history from Firestore in real-time
    useEffect(() => {
        if (!db || !isAuthReady || !userId) return;

        const historyColRef = collection(db, 'artifacts', appId, 'users', userId, 'history');
        const q = query(historyColRef);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedHistory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            fetchedHistory.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);
            setHistory(fetchedHistory);
        }, (error) => {
            console.error("Error fetching history: ", error);
        });

        return () => unsubscribe();
    }, [db, isAuthReady, userId]);

    // Function to handle fetching text from Gemini API for correction
    const fetchCorrectedText = async (text) => {
        try {
            const prompt = `Correct the following English text for grammar, punctuation, and spelling. Only provide the corrected text as a string, without any additional explanation or formatting. Text to correct: "${text}"`;
            const payload = {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
            };
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

            const response = await withExponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }));

            const result = await response.json();
            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                return result.candidates[0].content.parts[0].text;
            } else {
                console.error("Invalid API response format");
                return "Correction not available.";
            }
        } catch (error) {
            console.error("Error fetching correction:", error);
            return "Correction failed. Please try again.";
        }
    };

    // Function to handle text-to-speech conversion using Gemini API
    const fetchAudio = async (text) => {
        try {
            const payload = {
                contents: [{ parts: [{ text: text }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: "Puck" }
                        }
                    }
                },
                model: "gemini-2.5-flash-preview-tts"
            };

            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
            const response = await withExponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }));

            const result = await response.json();
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/")) {
                const pcmData = Uint8Array.from(atob(audioData), c => c.charCodeAt(0));
                const sampleRate = parseInt(mimeType.match(/rate=(\d+)/)[1], 10);
                const wavBlob = pcmToWav(new Int16Array(pcmData.buffer), sampleRate);
                return URL.createObjectURL(wavBlob);
            } else {
                console.error("Invalid audio response format");
                return null;
            }
        } catch (error) {
            console.error("Error fetching audio:", error);
            return null;
        }
    };

    // Handler for the "Start" button
    const handleStart = () => {
        setPhase('listen');
        // Clear previous data
        setUserText('');
        setCorrectedText('');
        setAudioUrl('');
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
        // Placeholder for future speech-to-text functionality
        alert("Please imagine you are speaking into a microphone now. Press 'Stop' when you are done.");
    };

    // Handler for the "Stop" button
    const handleStop = async () => {
        setIsCorrecting(true);
        // Placeholder for user spoken text
        const mockUserText = "I aint got no money today.";
        setUserText(mockUserText);

        const corrected = await fetchCorrectedText(mockUserText);
        setCorrectedText(corrected);
        setIsCorrecting(false);
        setPhase('result');
    };

    // Handler for the "Practice Again" button
    const handlePracticeAgain = () => {
        setPhase('start');
        setUserText('');
        setCorrectedText('');
        setAudioUrl('');
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
    };

    // Handler for the "Listen to Corrected" button
    const handleListenCorrected = async () => {
        if (audioUrl) {
            audioRef.current.play();
            return;
        }
        setIsGenerating(true);
        const url = await fetchAudio(correctedText);
        if (url) {
            setAudioUrl(url);
        }
        setIsGenerating(false);
    };

    // Handler to save the session to Firestore
    const handleSave = async () => {
        if (!db || !userId) return;

        const docRef = doc(collection(db, 'artifacts', appId, 'users', userId, 'history'));
        const sessionData = {
            originalText: userText,
            correctedText: correctedText,
            timestamp: new Date(),
        };

        try {
            await setDoc(docRef, sessionData);
            alert("Session saved successfully!");
        } catch (error) {
            console.error("Error saving session: ", error);
        }
    };

    const renderPhase = () => {
        switch (phase) {
            case 'start':
                return (
                    <button
                        onClick={handleStart}
                        className="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full transition-colors duration-200 shadow-lg transform hover:scale-105"
                    >
                        Start
                    </button>
                );
            case 'listen':
                return (
                    <button
                        onClick={handleStop}
                        className="px-8 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-full transition-colors duration-200 shadow-lg transform hover:scale-105 animate-pulse"
                    >
                        Stop Listening
                    </button>
                );
            case 'result':
                return (
                    <div className="flex flex-col items-center space-y-4 w-full">
                        {isCorrecting ? (
                            <div className="text-gray-500 flex items-center space-x-2">
                                <svg className="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <span>Correcting...</span>
                            </div>
                        ) : (
                            <>
                                <div className="w-full max-w-lg">
                                    <div className="mb-4">
                                        <h3 className="text-lg font-semibold text-gray-700 mb-2">You Said:</h3>
                                        <div className="bg-gray-100 p-4 rounded-lg border border-gray-300">
                                            <p className="text-gray-900">{userText}</p>
                                        </div>
                                    </div>
                                    <div className="mb-4">
                                        <h3 className="text-lg font-semibold text-gray-700 mb-2">Correct Version:</h3>
                                        <div className="bg-green-100 p-4 rounded-lg border border-green-300">
                                            <p className="text-gray-900">{correctedText}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex space-x-4">
                                    <button
                                        onClick={handleListenCorrected}
                                        className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-full transition-colors duration-200 shadow-lg disabled:opacity-50"
                                        disabled={isGenerating || !correctedText}
                                    >
                                        {isGenerating ? 'Generating...' : 'Listen to Corrected'}
                                    </button>
                                    <button
                                        onClick={handleSave}
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-full transition-colors duration-200 shadow-lg"
                                    >
                                        Save Session
                                    </button>
                                    <button
                                        onClick={handlePracticeAgain}
                                        className="px-6 py-2 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-full transition-colors duration-200 shadow-lg"
                                    >
                                        Practice Again
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4 font-sans text-gray-800">
            <header className="text-center mb-10 mt-10">
                <h1 className="text-5xl font-extrabold text-indigo-800 tracking-tight mb-2">Speech Buddy</h1>
                <p className="text-lg text-gray-600">Improve your English pronunciation and grammar with AI-powered feedback.</p>
                {userId && <p className="mt-2 text-sm text-gray-400">User ID: {userId}</p>}
            </header>

            <main className="w-full max-w-3xl flex flex-col items-center justify-center bg-white rounded-2xl shadow-xl p-8 transform transition-all duration-300 hover:shadow-2xl">
                {renderPhase()}
            </main>

            {/* Hidden audio element for playback */}
            {audioUrl && (
                <audio ref={audioRef} src={audioUrl} className="mt-4 w-full max-w-lg" controls autoPlay={false}>
                    Your browser does not support the audio element.
                </audio>
            )}

            {/* History Section */}
            {history.length > 0 && (
                <section className="mt-12 w-full max-w-3xl bg-white rounded-2xl shadow-xl p-8">
                    <h2 className="text-3xl font-bold text-gray-700 mb-6 text-center">Your Past Sessions</h2>
                    <div className="space-y-6">
                        {history.map((session, index) => (
                            <div key={session.id} className="bg-gray-50 p-6 rounded-lg shadow-sm border border-gray-200">
                                <div className="mb-4">
                                    <h3 className="text-lg font-semibold text-gray-700 mb-2">Original:</h3>
                                    <p className="text-gray-900 italic">"{session.originalText}"</p>
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold text-gray-700 mb-2">Corrected:</h3>
                                    <p className="text-gray-900 font-medium">"{session.correctedText}"</p>
                                </div>
                                <p className="text-xs text-gray-500 mt-4 text-right">
                                    {new Date(session.timestamp.seconds * 1000).toLocaleString()}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <footer className="mt-10 mb-4 text-sm text-gray-400 text-center">
                © {new Date().getFullYear()} Speech Buddy. All rights reserved.
            </footer>
        </div>
    );
};

export default App;
