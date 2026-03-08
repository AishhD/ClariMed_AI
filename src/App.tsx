/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { 
  FileText, 
  Upload, 
  Volume2, 
  Mic,
  MessageSquare, 
  CheckCircle2, 
  Loader2, 
  AlertCircle,
  ArrowRight,
  Play,
  Pause,
  Stethoscope,
  Heart,
  LogIn,
  LogOut,
  History,
  Send,
  User as UserIcon,
  MapPin,
  Activity,
  ExternalLink,
  Info,
  Trash2,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import { analyzeDiagnosticDocument, generateAudioFeedback, findSupportOrganizations, startChatSession, type DiagnosticFeedback } from './services/gemini.ts';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  deleteDoc,
  handleFirestoreError,
  OperationType,
  type User
} from './firebase.ts';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Error Boundary Component
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, errorInfo: string | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorInfo: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorInfo: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-rose-50 border border-rose-100 rounded-3xl m-6 text-center">
          <AlertCircle className="mx-auto text-rose-500 mb-4" size={48} />
          <h2 className="text-xl font-bold text-rose-800 mb-2">Something went wrong</h2>
          <p className="text-rose-600 mb-4">We encountered an error. This might be due to security rules or a network issue.</p>
          <pre className="text-xs bg-white p-4 rounded-xl text-left overflow-auto max-h-40 border border-rose-100">
            {this.state.errorInfo}
          </pre>
          <button 
            onClick={() => window.location.reload()}
            className="mt-6 px-6 py-2 bg-rose-600 text-white rounded-xl font-bold hover:bg-rose-700 transition-colors"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inputText, setInputText] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [feedback, setFeedback] = useState<DiagnosticFeedback | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSession, setChatSession] = useState<any>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [activeTab, setActiveTab] = useState<'summary' | 'ask-clarimed' | 'support' | 'conditions-map' | 'ask-your-dr'>('summary');
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [supportData, setSupportData] = useState<{ text: string, organizations: { title: string, uri: string }[] } | null>(null);
  const [isSearchingSupport, setIsSearchingSupport] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Reset audio when base64 changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsPlaying(false);
    }
  }, [audioBase64]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        // Sync user profile to Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        try {
          await setDoc(userRef, {
            uid: currentUser.uid,
            email: currentUser.email,
            displayName: currentUser.displayName,
            photoURL: currentUser.photoURL,
            createdAt: new Date().toISOString()
          }, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
        }
      }
    });
    return unsubscribe;
  }, []);

  // History Listener
  useEffect(() => {
    if (isAuthReady && user) {
      const q = query(
        collection(db, 'analyses'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc')
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setHistory(items);
      }, (err) => {
        handleFirestoreError(err, OperationType.GET, 'analyses');
      });

      return unsubscribe;
    }
  }, [isAuthReady, user]);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed", err);
      setError("Failed to sign in with Google.");
    }
  };

  const logout = () => auth.signOut();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const analyze = async () => {
    if (!file && !inputText.trim()) return;
    
    setIsAnalyzing(true);
    setError(null);
    setFeedback(null);
    setAudioBase64(null);
    setSupportData(null);
    setChatMessages([]);
    setChatSession(null);

    try {
      let base64: string | undefined;
      let mimeType: string | undefined;

      if (file) {
        const reader = new FileReader();
        const fileData = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        base64 = fileData;
        mimeType = file.type || (file.name.endsWith('.txt') ? 'text/plain' : undefined);
      }

      // 1. Analyze Document/Text
      const result = await analyzeDiagnosticDocument({ 
        fileBase64: base64, 
        mimeType: mimeType, 
        text: inputText.trim() || undefined 
      });
      setFeedback(result);

      // 2. Start generating audio in background
      const audio = await generateAudioFeedback(result);
      if (audio) setAudioBase64(audio);

      // 3. Initialize chat session
      const session = await startChatSession(result);
      setChatSession(session);

      // 4. Find Support Organizations in background
      setIsSearchingSupport(true);
      try {
        let location: { lat: number, lng: number } | undefined;
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3000 });
          });
          location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        } catch (e) {
          console.warn("Location access denied or timed out");
        }
        const support = await findSupportOrganizations(result.condition, location);
        setSupportData(support);
      } catch (err) {
        console.error("Support search failed", err);
      } finally {
        setIsSearchingSupport(false);
      }

      // 5. Save to Firestore if logged in
      if (user) {
        try {
          await addDoc(collection(db, 'analyses'), {
            userId: user.uid,
            fileName: file?.name || 'Text Analysis',
            condition: result.condition,
            symptoms: result.symptoms,
            summary: result.summary,
            bulletPoints: result.bulletPoints,
            recommendations: result.recommendations,
            glossary: result.glossary,
            questionsForDoctor: result.questionsForDoctor,
            audioBase64: audio || null,
            createdAt: new Date().toISOString()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, 'analyses');
        }
      }
    } catch (err: any) {
      setError("Analysis failed. Please try again with a clearer document or description.");
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleAudio = () => {
    if (!audioRef.current && audioBase64) {
      const audioBlob = b64toBlob(audioBase64, 'audio/wav');
      const audioUrl = URL.createObjectURL(audioBlob);
      audioRef.current = new Audio(audioUrl);
      audioRef.current.onended = () => setIsPlaying(false);
    }

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const b64toBlob = (b64Data: string, contentType = '', sliceSize = 512) => {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }
    return new Blob(byteArrays, { type: contentType });
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim() || !chatSession || isSendingChat) return;

    const userMessage = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsSendingChat(true);

    try {
      const response = await chatSession.sendMessage({ message: userMessage });
      setChatMessages(prev => [...prev, { role: 'model', text: response.text || "I'm sorry, I couldn't process that." }]);
    } catch (err) {
      console.error("Chat error", err);
      setChatMessages(prev => [...prev, { role: 'model', text: "Sorry, I encountered an error. Please try again." }]);
    } finally {
      setIsSendingChat(false);
    }
  };

  const loadFromHistory = async (item: any) => {
    const fb = {
      summary: item.summary,
      condition: item.condition || 'Unknown',
      symptoms: item.symptoms || [],
      bulletPoints: item.bulletPoints || [],
      recommendations: item.recommendations || [],
      glossary: item.glossary || [],
      questionsForDoctor: item.questionsForDoctor || []
    };
    setFeedback(fb);
    setAudioBase64(item.audioBase64);
    setChatMessages([]);
    setShowHistory(false);
    setActiveTab('summary');
    
    // Re-init chat session
    const session = await startChatSession(fb);
    setChatSession(session);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsPlaying(false);
    }
  };

  const deleteHistoryItem = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this analysis?")) return;
    try {
      await deleteDoc(doc(db, 'analyses', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `analyses/${id}`);
    }
  };

  const clearAllHistory = async () => {
    if (!confirm("Are you sure you want to clear your entire history? This cannot be undone.")) return;
    try {
      const deletePromises = history.map(item => deleteDoc(doc(db, 'analyses', item.id)));
      await Promise.all(deletePromises);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'analyses');
    }
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-emerald-100">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative w-10 h-10 flex items-center justify-center">
                <div className="absolute inset-0 border-[3px] border-cyan-600 rounded-full border-r-transparent -rotate-45"></div>
                <div className="absolute bottom-0 right-0 w-3.5 h-1 bg-cyan-600 rounded-full rotate-45 origin-left translate-x-0.5 translate-y-0.5"></div>
                <div className="z-10 bg-emerald-500 text-white w-5 h-5 rounded-full flex items-center justify-center shadow-sm">
                  <MessageSquare size={10} fill="currentColor" />
                </div>
              </div>
              <span className="font-bold text-2xl tracking-tight text-cyan-700">Clari<span className="text-emerald-500">Med</span></span>
            </div>
            
            <div className="flex items-center gap-4">
              {user ? (
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => setShowHistory(!showHistory)}
                    className="p-2 text-slate-500 hover:bg-slate-100 rounded-xl transition-colors relative"
                  >
                    <History size={20} />
                    {history.length > 0 && (
                      <span className="absolute top-1 right-1 w-2 h-2 bg-emerald-500 rounded-full border-2 border-white"></span>
                    )}
                  </button>
                  <div className="h-8 w-px bg-slate-200"></div>
                  <div className="flex items-center gap-2">
                    <img src={user.photoURL || ''} alt={user.displayName || ''} className="w-8 h-8 rounded-full border border-slate-200" />
                    <button onClick={logout} className="text-sm font-bold text-slate-500 hover:text-rose-500 transition-colors">
                      <LogOut size={18} />
                    </button>
                  </div>
                </div>
              ) : (
                <button 
                  onClick={login}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all"
                >
                  <LogIn size={16} />
                  Sign In
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-12 space-y-12">
          <section className="text-center max-w-3xl mx-auto">
            <h1 className="text-4xl font-extrabold text-slate-900 leading-tight mb-4">
              Understand your <span className="text-cyan-600">diagnosis</span> with <span className="text-emerald-500">ClariMed</span>
            </h1>
            <p className="text-slate-600 text-lg leading-relaxed">
              Upload your medical reports or paste your results. Our AI provides a supportive, clear explanation and answers your questions.
            </p>
          </section>

          {showHistory && user && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-12 bg-white border border-slate-200 rounded-3xl p-6 shadow-sm"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <History size={18} className="text-emerald-500" />
                    Your Analysis History
                  </h3>
                  <span className="text-xs font-medium bg-slate-100 text-slate-500 px-2 py-1 rounded-full">
                    {history.length} items
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {history.length > 0 && (
                    <button 
                      onClick={clearAllHistory}
                      className="text-xs font-bold text-rose-500 hover:text-rose-600 flex items-center gap-1 transition-colors"
                    >
                      <Trash2 size={14} />
                      Clear All
                    </button>
                  )}
                  <button onClick={() => setShowHistory(false)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all">
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {history.length === 0 ? (
                  <div className="col-span-full text-center py-12 bg-slate-50/50 rounded-2xl border border-dashed border-slate-200">
                    <History size={32} className="mx-auto text-slate-300 mb-3" />
                    <p className="text-slate-400 text-sm">No history found yet. Your analyses will appear here.</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div key={item.id} className="relative group">
                      <button
                        onClick={() => loadFromHistory(item)}
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-left hover:border-emerald-500 hover:bg-white transition-all group-hover:shadow-md"
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <p className="font-bold text-slate-800 text-sm truncate group-hover:text-emerald-600">
                            {item.fileName || 'Untitled Analysis'}
                          </p>
                          <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0">
                            {item.condition || 'Analysis'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-slate-400 flex items-center gap-1">
                            <Activity size={10} />
                            {new Date(item.createdAt).toLocaleDateString()}
                          </p>
                          <div className="flex items-center gap-1">
                            {item.audioBase64 && <Volume2 size={12} className="text-emerald-500" />}
                          </div>
                        </div>
                      </button>
                      <button 
                        onClick={(e) => deleteHistoryItem(e, item.id)}
                        className="absolute top-2 right-2 p-1.5 bg-white border border-slate-100 text-slate-300 hover:text-rose-500 hover:border-rose-100 rounded-lg opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                        title="Delete analysis"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}

          {/* Results Section - Now at the Top when active */}
          <AnimatePresence mode="wait">
            {(isAnalyzing || feedback) && (
              <motion.div 
                key="results-container"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="w-full"
              >
                {isAnalyzing ? (
                  <div className="bg-white rounded-[32px] border border-slate-200 p-12 flex flex-col items-center justify-center text-center space-y-6 shadow-sm">
                    <div className="relative">
                      <div className="w-24 h-24 border-4 border-emerald-100 rounded-full animate-pulse"></div>
                      <Loader2 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-emerald-500 animate-spin" size={40} />
                    </div>
                    <div>
                      <h3 className="text-2xl font-bold text-slate-800">Processing Diagnostic</h3>
                      <p className="text-slate-500 mt-2 max-w-xs mx-auto">
                        Our AI is carefully reading your information to provide the most accurate feedback.
                      </p>
                    </div>
                  </div>
                ) : feedback ? (
                  <div className="bg-white rounded-[32px] border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                    {/* Tabs */}
                        <div className="flex border-b border-slate-100 p-2 bg-slate-50/50 overflow-x-auto custom-scrollbar">
                          {[
                            { id: 'summary', icon: <FileText size={18} />, label: 'Summary' },
                            { id: 'conditions-map', icon: <Activity size={18} />, label: 'Conditions Map' },
                            { id: 'ask-your-dr', icon: <MessageSquare size={18} />, label: 'Ask Your Dr' },
                            { id: 'support', icon: <MapPin size={18} />, label: 'Community' },
                            { id: 'ask-clarimed', icon: <MessageSquare size={18} />, label: 'Ask ClariMed' }
                          ].map((tab) => (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id as any)}
                          className={cn(
                            "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold transition-all",
                            activeTab === tab.id 
                              ? "bg-white text-emerald-600 shadow-sm" 
                              : "text-slate-400 hover:text-slate-600"
                          )}
                        >
                          {tab.icon}
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    <div className="p-8">
                      {activeTab === 'summary' && (
                        <div className="space-y-8">
                          {/* Audio Explanation Button */}
                          <div className="flex justify-center">
                            {!audioBase64 ? (
                              <div className="flex items-center gap-2 text-slate-400 text-xs font-bold uppercase tracking-widest">
                                <Loader2 className="animate-spin" size={14} />
                                Preparing Audio...
                              </div>
                            ) : (
                              <button
                                onClick={toggleAudio}
                                className={cn(
                                  "flex items-center gap-2 px-6 py-2.5 rounded-2xl font-bold text-sm transition-all shadow-sm",
                                  isPlaying 
                                    ? "bg-rose-500 text-white hover:bg-rose-600" 
                                    : "bg-emerald-500 text-white hover:bg-emerald-600"
                                )}
                              >
                                {isPlaying ? (
                                  <>
                                    <Pause size={18} fill="currentColor" />
                                    Pause Explanation
                                  </>
                                ) : (
                                  <>
                                    <Mic size={18} />
                                    Audio Explanation
                                  </>
                                )}
                              </button>
                            )}
                          </div>

                          <section>
                            <h3 className="text-xs font-bold text-emerald-600 uppercase tracking-widest mb-4">Executive Summary</h3>
                            <div className="text-slate-700 leading-relaxed space-y-4">
                              <Markdown>{feedback.summary}</Markdown>
                            </div>
                          </section>

                          <section>
                            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Key Findings</h3>
                            <ul className="space-y-3">
                              {feedback.bulletPoints.map((point, i) => (
                                <li key={i} className="flex gap-3 items-start">
                                  <div className="w-5 h-5 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500 shrink-0 mt-0.5">
                                    <CheckCircle2 size={14} />
                                  </div>
                                  <span className="text-slate-700 leading-relaxed">{point}</span>
                                </li>
                              ))}
                            </ul>
                          </section>

                          {feedback.glossary && feedback.glossary.length > 0 && (
                            <section>
                              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Medical Glossary</h3>
                              <div className="grid sm:grid-cols-2 gap-4">
                                {feedback.glossary.map((item, i) => (
                                  <div key={i} className="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                                    <h4 className="font-bold text-slate-800 text-sm mb-1">{item.term}</h4>
                                    <p className="text-xs text-slate-500 leading-relaxed">{item.definition}</p>
                                  </div>
                                ))}
                              </div>
                            </section>
                          )}

                          <section className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Recommendations</h3>
                            <ul className="space-y-3">
                              {feedback.recommendations.map((rec, i) => (
                                <li key={i} className="flex gap-3 items-start">
                                  <div className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0 mt-2.5"></div>
                                  <span className="text-slate-600 text-sm leading-relaxed">{rec}</span>
                                </li>
                              ))}
                            </ul>
                          </section>
                        </div>
                      )}

                      {activeTab === 'conditions-map' && (
                        <div className="space-y-8">
                          <section className="py-6">
                            <div className="mb-8">
                              <h3 className="text-2xl font-bold text-slate-800">Condition & Symptoms Map</h3>
                              <p className="text-slate-500 mt-1">A visual representation of your condition and associated symptoms.</p>
                            </div>
                            <div className="relative flex flex-col items-center">
                              <div className="z-10 bg-emerald-500 text-white px-6 py-3 rounded-2xl font-bold shadow-lg shadow-emerald-200 flex items-center gap-2 mb-12">
                                <Activity size={20} />
                                {feedback.condition}
                              </div>
                              
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 w-full">
                                {feedback.symptoms.map((symptom, i) => (
                                  <div key={i} className="relative group">
                                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-px h-12 bg-emerald-100 group-hover:bg-emerald-300 transition-colors hidden md:block"></div>
                                    <div className="bg-white border border-slate-100 p-4 rounded-2xl shadow-sm text-center group-hover:border-emerald-200 group-hover:bg-emerald-50/30 transition-all">
                                      <span className="text-sm font-medium text-slate-700">{symptom}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </section>
                        </div>
                      )}

                      {activeTab === 'ask-your-dr' && (
                        <div className="space-y-8">
                          {feedback.questionsForDoctor && feedback.questionsForDoctor.length > 0 && (
                            <section className="bg-emerald-50/50 rounded-[32px] p-8 border border-emerald-100/50">
                              <div className="mb-8">
                                <h3 className="text-2xl font-bold text-slate-800">Ask Your Dr</h3>
                                <p className="text-slate-500 mt-1">Use these questions during your next appointment to get more clarity.</p>
                              </div>
                              <ul className="space-y-4">
                                {feedback.questionsForDoctor.map((q, i) => (
                                  <li key={i} className="flex gap-4 items-start bg-white p-6 rounded-2xl border border-emerald-50 shadow-sm">
                                    <div className="w-8 h-8 rounded-xl bg-emerald-500 text-white flex items-center justify-center shrink-0 font-bold">
                                      {i + 1}
                                    </div>
                                    <span className="text-slate-700 font-medium leading-relaxed italic">"{q}"</span>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}
                        </div>
                      )}

                      {activeTab === 'support' && (
                        <div className="space-y-8">
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div>
                              <h3 className="text-2xl font-bold text-slate-800">Community</h3>
                              <p className="text-slate-500 mt-1">Found organizations and resources related to {feedback.condition}.</p>
                            </div>
                            {isSearchingSupport && (
                              <div className="flex items-center gap-2 text-emerald-600 font-bold text-sm bg-emerald-50 px-4 py-2 rounded-xl">
                                <Loader2 className="animate-spin" size={16} />
                                Searching nearby...
                              </div>
                            )}
                          </div>

                          {supportData ? (
                            <div className="space-y-4">
                              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Organizations</h4>
                              {supportData.organizations.length > 0 ? (
                                <div className="grid sm:grid-cols-2 gap-4">
                                  {supportData.organizations.slice(0, 4).map((org, i) => {
                                    const domain = new URL(org.uri).hostname;
                                    const logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
                                    
                                    return (
                                      <a 
                                        key={i}
                                        href={org.uri}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl hover:border-emerald-500 hover:shadow-md transition-all group"
                                      >
                                        <div className="flex items-center gap-3">
                                          <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center overflow-hidden border border-slate-100 group-hover:border-emerald-200 transition-colors">
                                            <img 
                                              src={logoUrl} 
                                              alt={org.title} 
                                              className="w-8 h-8 object-contain"
                                              referrerPolicy="no-referrer"
                                              onError={(e) => {
                                                (e.target as HTMLImageElement).src = `https://ui-avatars.com/api/?name=${encodeURIComponent(org.title)}&background=10b981&color=fff`;
                                              }}
                                            />
                                          </div>
                                          <div className="flex flex-col">
                                            <span className="font-bold text-slate-800 text-sm line-clamp-1">{org.title}</span>
                                            <span className="text-[10px] text-slate-400 truncate max-w-[150px]">{domain}</span>
                                          </div>
                                        </div>
                                        <ExternalLink size={16} className="text-slate-300 group-hover:text-emerald-500 transition-colors shrink-0" />
                                      </a>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="p-8 bg-slate-50 rounded-3xl border border-dashed border-slate-200 text-center">
                                  <Info className="mx-auto text-slate-300 mb-2" size={24} />
                                  <p className="text-sm text-slate-400">No specific organizations found for this condition.</p>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="py-20 flex flex-col items-center justify-center text-center space-y-4">
                              <Loader2 className="animate-spin text-emerald-500" size={40} />
                              <p className="text-slate-500 font-medium">Finding community resources for you...</p>
                            </div>
                          )}
                        </div>
                      )}


                      {activeTab === 'ask-clarimed' && (
                        <div className="flex flex-col h-[500px]">
                          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                            {chatMessages.length === 0 && (
                              <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 space-y-4">
                                <MessageSquare size={48} className="opacity-20" />
                                <p className="max-w-xs text-sm">
                                  Ask any follow-up questions about your analysis. I'm here to help you understand.
                                </p>
                              </div>
                            )}
                            {chatMessages.map((msg, i) => (
                              <div 
                                key={i} 
                                className={cn(
                                  "flex",
                                  msg.role === 'user' ? "justify-end" : "justify-start"
                                )}
                              >
                                <div className={cn(
                                  "max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm",
                                  msg.role === 'user' 
                                    ? "bg-emerald-500 text-white rounded-tr-none" 
                                    : "bg-slate-50 text-slate-700 border border-slate-100 rounded-tl-none"
                                )}>
                                  <Markdown>{msg.text}</Markdown>
                                </div>
                              </div>
                            ))}
                            {isSendingChat && (
                              <div className="flex justify-start">
                                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl rounded-tl-none flex gap-2">
                                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce"></div>
                                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                                </div>
                              </div>
                            )}
                          </div>
                          
                          <div className="p-4 border-t border-slate-100 bg-slate-50/50">
                            <div className="relative flex items-center">
                              <input
                                type="text"
                                value={chatInput}
                                onChange={(e) => setChatInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                                placeholder="Ask a follow-up question..."
                                className="w-full pl-4 pr-12 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all"
                              />
                              <button 
                                onClick={handleSendMessage}
                                disabled={!chatInput.trim() || isSendingChat}
                                className="absolute right-2 p-2 text-emerald-500 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-30"
                              >
                                <Send size={18} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                    </div>
                  </div>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid lg:grid-cols-12 gap-12">
            {/* Left Column: Upload & Instructions */}
            <div className="lg:col-span-5 space-y-8">
              <div className="space-y-6">
                {/* Combined Input Section */}
                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">1. Upload Document (Optional)</label>
                    <div 
                      className={cn(
                        "border-2 border-dashed rounded-3xl p-8 transition-all duration-300 flex flex-col items-center justify-center gap-3 cursor-pointer group",
                        file ? "border-emerald-500 bg-emerald-50/50" : "border-slate-200 hover:border-emerald-400 hover:bg-slate-50"
                      )}
                      onClick={() => document.getElementById('file-upload')?.click()}
                    >
                      <input 
                        id="file-upload" 
                        type="file" 
                        className="hidden" 
                        onChange={handleFileUpload}
                        accept=".pdf,.jpg,.jpeg,.png,.txt"
                      />
                      <div className={cn(
                        "w-12 h-12 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110",
                        file ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"
                      )}>
                        {file ? <FileText size={24} /> : <Upload size={24} />}
                      </div>
                      <div className="text-center">
                        <p className="font-semibold text-slate-800 text-sm">
                          {file ? file.name : "Select a document"}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          PDF, PNG, JPG or TXT
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">2. Add Context or Symptoms (Optional)</label>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder="Describe how you feel or paste diagnostic results here..."
                      className="w-full h-32 p-4 bg-white border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all resize-none shadow-sm"
                    />
                  </div>
                </div>

                <button
                  disabled={(!file && !inputText.trim()) || isAnalyzing}
                  onClick={analyze}
                  className="w-full bg-slate-900 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-slate-200"
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="animate-spin" size={20} />
                      Analyzing Document...
                    </>
                  ) : (
                    <>
                      Analyze Feedback
                      <ArrowRight size={20} />
                    </>
                  )}
                </button>

                {!user && !isAnalyzing && (
                  <p className="text-xs text-center text-slate-400 bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <LogIn size={12} className="inline mr-1" />
                    Sign in to save your analysis history securely.
                  </p>
                )}

                {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-start gap-3 text-rose-700 text-sm"
                  >
                    <AlertCircle size={18} className="shrink-0 mt-0.5" />
                    <p>{error}</p>
                  </motion.div>
                )}
              </div>

              <div className="pt-8 border-t border-slate-200">
                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">How it works</h3>
                <div className="space-y-6">
                  {[
                    { icon: <FileText size={18} />, title: "Secure Upload", desc: "Your documents are processed securely and privately." },
                    { icon: <CheckCircle2 size={18} />, title: "AI Analysis", desc: "Gemini Pro analyzes complex medical terminology." },
                    { icon: <MessageSquare size={18} />, title: "Follow-up", desc: "Ask questions to better understand your results." }
                  ].map((step, i) => (
                    <div key={i} className="flex gap-4">
                      <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                        {step.icon}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-800 text-sm">{step.title}</h4>
                        <p className="text-xs text-slate-500 mt-0.5">{step.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Empty state or side info when no analysis */}
            <div className="lg:col-span-7">
              {!(isAnalyzing || feedback) && (
                <motion.div 
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="h-full min-h-[500px] bg-slate-50 rounded-[32px] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-center p-12"
                >
                  <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center text-slate-300 mb-6">
                    <FileText size={40} />
                  </div>
                  <h3 className="text-xl font-bold text-slate-400">No Analysis Yet</h3>
                  <p className="text-slate-400 mt-2 max-w-xs mx-auto">
                    Upload a diagnostic document or describe your symptoms on the left to receive AI-powered feedback.
                  </p>
                </motion.div>
              )}
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-slate-200 mt-12">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2 text-slate-400">
              <div className="w-6 h-6 bg-cyan-600 rounded-lg flex items-center justify-center text-white scale-75">
                <MessageSquare size={12} fill="currentColor" />
              </div>
              <span className="text-sm font-medium">ClariMed &copy; 2024</span>
            </div>
            <div className="flex gap-8 text-sm font-medium text-slate-400">
              <a href="#" className="hover:text-slate-600">Privacy Policy</a>
              <a href="#" className="hover:text-slate-600">Terms of Service</a>
              <a href="#" className="hover:text-slate-600">Medical Disclaimer</a>
            </div>
          </div>
        </footer>

        <style>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 6px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #E2E8F0;
            border-radius: 10px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #CBD5E1;
          }
        `}</style>
      </div>
    </ErrorBoundary>
  );
}
