#!/usr/bin/env python3
"""Audio analyzer service - Essentia-based analysis with TensorFlow ML models"""

# CRITICAL: TensorFlow threading MUST be configured before any imports.
# Environment variables are read by TensorFlow C++ runtime before initialization.
import os
import sys

# Get thread configuration from environment (default to 1 for safety)
THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))

# Configure TensorFlow threading via environment variables
# These are read by TensorFlow C++ runtime before thread pool initialization
# Must be set BEFORE any TensorFlow/Essentia imports load TensorFlow
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'  # Reduce TF logging noise
os.environ['TF_NUM_INTRAOP_THREADS'] = str(THREADS_PER_WORKER)  # Threads within ops
os.environ['TF_NUM_INTEROP_THREADS'] = '1'  # Serialize op scheduling

# Also set NumPy/BLAS/OpenMP limits for non-TensorFlow operations
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

# Log thread configuration on startup
print("=" * 80, file=sys.stderr)
print("AUDIO ANALYZER THREAD CONFIGURATION", file=sys.stderr)
print("=" * 80, file=sys.stderr)
print(f"TF_NUM_INTRAOP_THREADS: {THREADS_PER_WORKER}", file=sys.stderr)
print(f"TF_NUM_INTEROP_THREADS: 1", file=sys.stderr)
print(f"OpenMP/BLAS threads: {THREADS_PER_WORKER}", file=sys.stderr)
print(f"Expected CPU usage: ~{THREADS_PER_WORKER * 100 + 100}% per worker", file=sys.stderr)
print("=" * 80, file=sys.stderr)

"""
Essentia audio analyzer: BPM, key, energy, danceability, mood heads, valence
and arousal from MusiCNN models, with heuristics when the models are missing.
Jobs arrive over Redis; results go to PostgreSQL.
"""

# NOW safe to import other dependencies
import json
import time
import logging
import gc
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List, Tuple
import traceback
import subprocess
import numpy as np
from concurrent.futures import (
    ProcessPoolExecutor,
    as_completed,
    TimeoutError as FuturesTimeoutError,
)
import multiprocessing

from concurrent.futures.process import BrokenProcessPool

# Force spawn mode for TensorFlow compatibility (must be called before any multiprocessing)
try:
    multiprocessing.set_start_method('spawn', force=True)
except RuntimeError:
    pass  # Already set

import redis
import psycopg2
from psycopg2.extras import RealDictCursor

# Failure-class routing lives in classifier.py (pure stdlib). analyzer.py
# must import and call it — the single failure choke point is
# AnalysisWorker._save_failed, so every failure surface inherits the rule
# with zero per-site plumbing.
from classifier import (
    classify_failure,
    classify_with_codec,
    tag_error,
    Disposition,
)

# max_tasks_per_child needs Python 3.11; this image ships 3.8 for
# essentia-tensorflow, where passing it raises TypeError.
def _pool_recycle_kwargs(limit: int) -> dict:
    return {"max_tasks_per_child": limit} if sys.version_info >= (3, 11) else {}



# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('audio-analyzer')

# Essentia imports (will fail gracefully if not installed for testing)
ESSENTIA_AVAILABLE = False
try:
    import essentia
    # Suppress Essentia's internal "No network created" warnings that spam logs
    essentia.log.warningActive = False
    essentia.log.infoActive = False
    import essentia.standard as es
    ESSENTIA_AVAILABLE = True
except ImportError as e:
    logger.warning(f"Essentia not available: {e}")

# TensorFlow models via Essentia
# NOTE: TF is NOT imported in the main process to save ~300MB RAM.
# Worker processes import TF independently via spawn mode.
# TF_MODELS_AVAILABLE is set after MODELS dict is defined below.
TF_MODELS_AVAILABLE = False
TensorflowPredictMusiCNN = None  # Loaded in worker processes

# Configuration from environment
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
MUSIC_PATH = os.getenv('MUSIC_PATH', '/music')
BATCH_SIZE = int(os.getenv('BATCH_SIZE', '10'))
SLEEP_INTERVAL = int(os.getenv('SLEEP_INTERVAL', '5'))

# BRPOP timeout: how long to block waiting for work (seconds)
# Also serves as the DB reconciliation interval
# Uses SLEEP_INTERVAL for backward compatibility, minimum 5s
BRPOP_TIMEOUT = max(5, int(os.getenv('BRPOP_TIMEOUT', str(SLEEP_INTERVAL))))

# Idle timeout before unloading ML models from memory (seconds)
# Models are reloaded automatically when new work arrives
MODEL_IDLE_TIMEOUT = int(os.getenv('MODEL_IDLE_TIMEOUT', '300'))

# Debounce delay for worker resize (seconds) -- prevents pool churn when user drags a slider
RESIZE_DEBOUNCE_SECONDS = 5


class DatabaseConnection:
    """PostgreSQL connection manager"""

    def __init__(self, url: str):
        self.url = url
        self.conn = None

    def connect(self):
        """Establish database connection with explicit UTF-8 encoding"""
        if not self.url:
            raise ValueError("DATABASE_URL not set")

        self.conn = psycopg2.connect(
            self.url,
            options="-c client_encoding=UTF8"
        )
        self.conn.set_client_encoding('UTF8')
        self.conn.autocommit = False
        logger.info("Connected to PostgreSQL with UTF-8 encoding")

    def get_cursor(self):
        """Get a database cursor"""
        if not self.conn:
            self.connect()
        return self.conn.cursor(cursor_factory=RealDictCursor)

    def commit(self):
        """Commit transaction"""
        if self.conn:
            self.conn.commit()

    def rollback(self):
        """Rollback transaction"""
        if self.conn:
            self.conn.rollback()

    def close(self):
        """Close connection"""
        if self.conn:
            self.conn.close()
            self.conn = None


def _get_workers_from_db() -> int:
    """
    Fetch worker count from SystemSettings table.
    Falls back to env var or default if database query fails.
    """
    try:
        db = DatabaseConnection(DATABASE_URL)
        db.connect()
        cursor = db.get_cursor()
        
        cursor.execute("""
            SELECT "audioAnalyzerWorkers"
            FROM "SystemSettings"
            WHERE id = 'default'
            LIMIT 1
        """)
        
        result = cursor.fetchone()
        cursor.close()
        db.close()
        
        if result and result['audioAnalyzerWorkers'] is not None:
            workers = int(result['audioAnalyzerWorkers'])
            # Validate range (1-8)
            workers = max(1, min(8, workers))
            logger.info(f"Loaded worker count from database: {workers}")
            return workers
        else:
            logger.info("No worker count found in database, using env var or default")
            return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))
            
    except Exception as e:
        logger.warning(f"Failed to fetch worker count from database: {e}")
        logger.info("Falling back to env var or default")
        return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))
# Two workers fit any machine's memory.
DEFAULT_WORKERS = 2
# Try to load from database first, fall back to env var or default
NUM_WORKERS = _get_workers_from_db()
# Bump when stored features change meaning, so older rows can be re-queued.
ESSENTIA_VERSION = '2.1b6-enhanced-v3'

# Same cap and ladder as the backend (STAGE_RETRY_CAP, computeStageRetryWaitMs):
# an INCONCLUSIVE failure retries after 1 min, 10 min, then 1 h, and the 4th
# failure closes the record.
STAGE_RETRY_LADDER_SECONDS = [60, 600, 3600]
STAGE_RETRY_CAP = 4


def compute_stage_retry_wait_seconds(attempt: int) -> int:
    """Mirror of computeStageRetryWaitMs: the ladder entry for that attempt."""
    return STAGE_RETRY_LADDER_SECONDS[min(max(1, attempt), 3) - 1]
# Seconds to allow the single ffmpeg decode before giving up on the track.
# Replaces PRE_DECODE_PROBE_TIMEOUT: there is no separate integrity probe
# any more -- the one decode IS the check.
DECODE_TIMEOUT = int(os.getenv('DECODE_TIMEOUT', '120'))

# Queue names
ANALYSIS_QUEUE = 'audio:analysis:queue'

# Control channel for enrichment coordination
CONTROL_CHANNEL = 'audio:analysis:control'

# Model paths (pre-packaged in Docker image)
MODEL_DIR = '/app/models'

# MusiCNN model file paths (official Essentia models from essentia.upf.edu/models/)
# Valence/arousal use DEAM regression model when available, heuristic fallback otherwise
MODELS = {
    # Base MusiCNN embedding model (for auto-tagging)
    'musicnn': os.path.join(MODEL_DIR, 'msd-musicnn-1.pb'),
    'musicnn_metadata': os.path.join(MODEL_DIR, 'msd-musicnn-1.json'),
    # Mood classification heads (MusiCNN architecture)
    # Correct filenames: {task}-msd-musicnn-1.pb
    'mood_happy': os.path.join(MODEL_DIR, 'mood_happy-msd-musicnn-1.pb'),
    'mood_sad': os.path.join(MODEL_DIR, 'mood_sad-msd-musicnn-1.pb'),
    'mood_relaxed': os.path.join(MODEL_DIR, 'mood_relaxed-msd-musicnn-1.pb'),
    'mood_aggressive': os.path.join(MODEL_DIR, 'mood_aggressive-msd-musicnn-1.pb'),
    'mood_party': os.path.join(MODEL_DIR, 'mood_party-msd-musicnn-1.pb'),
    'mood_acoustic': os.path.join(MODEL_DIR, 'mood_acoustic-msd-musicnn-1.pb'),
    'mood_electronic': os.path.join(MODEL_DIR, 'mood_electronic-msd-musicnn-1.pb'),
    'danceability': os.path.join(MODEL_DIR, 'danceability-msd-musicnn-1.pb'),
    # voice_instrumental excluded: broken head, CLAP zero-shot replaces it
    # Valence/Arousal regression (outputs [valence, arousal], range 1-9)
    'deam': os.path.join(MODEL_DIR, 'deam-msd-musicnn-2.pb'),
    'emomusic': os.path.join(MODEL_DIR, 'emomusic-msd-musicnn-2.pb'),
}

# Output column order of each head, from the "classes" field of Essentia's model
# metadata (essentia.upf.edu/models/classification-heads/<head>/). The positive
# class is first for some heads and second for others.
HEAD_CLASSES = {
    'mood_happy': ['happy', 'non_happy'],
    'mood_sad': ['non_sad', 'sad'],
    'mood_relaxed': ['non_relaxed', 'relaxed'],
    'mood_aggressive': ['aggressive', 'not_aggressive'],
    'mood_party': ['non_party', 'party'],
    'mood_acoustic': ['acoustic', 'non_acoustic'],
    'mood_electronic': ['electronic', 'non_electronic'],
    'danceability': ['danceable', 'not_danceable'],
}
HEAD_POSITIVE_CLASS = {
    'mood_happy': 'happy',
    'mood_sad': 'sad',
    'mood_relaxed': 'relaxed',
    'mood_aggressive': 'aggressive',
    'mood_party': 'party',
    'mood_acoustic': 'acoustic',
    'mood_electronic': 'electronic',
    'danceability': 'danceable',
}


def positive_class_index(head: str) -> int:
    """Column of the head's softmax output that holds P(positive class)."""
    return HEAD_CLASSES[head].index(HEAD_POSITIVE_CLASS[head])


# Now that MODELS is defined, check if model files exist on disk
TF_MODELS_AVAILABLE = os.path.exists(MODELS['musicnn'])
if TF_MODELS_AVAILABLE:
    logger.info(f"MusiCNN model files found at {MODEL_DIR}")
else:
    logger.info(f"MusiCNN model files not found at {MODEL_DIR} - Standard mode only")


def _decode_to_stereo(file_path: str, duration: int = 90):
    """Decode the first ``duration`` seconds of the first audio stream to
    stereo with one ffmpeg call, skipping bad frames rather than failing.

    Returns ``(samples, sample_rate, channels, duration, command, rc, stderr,
    class)``: samples is ``(channels, n)`` float32 or None, class is the
    ``classify_failure`` disposition of whatever ffmpeg reported.
    """
    command = [
        'ffmpeg', '-nostdin', '-v', 'error',
        '-err_detect', 'ignore_err',
        '-ss', '0', '-t', str(duration),
        '-i', file_path,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '2', '-ar', '44100',
        '-c:a', 'pcm_s16le',
        '-f', 's16le', '-',
    ]
    try:
        proc = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=DECODE_TIMEOUT,
        )
        rc = proc.returncode
        stderr_text = proc.stderr.decode('utf-8', 'replace').strip()
        raw = proc.stdout
    except Exception as e:  # timeout, missing ffmpeg, spawn failure
        return (None, 44100, 0, 0.0, command, -1,
                f"decode command failed: {e}",
                classify_failure(f"decode command failed: {e}"))

    if raw:
        samples = np.frombuffer(raw, dtype='<i2')
        if samples.size % 2:
            samples = samples[:samples.size - 1]  # truncated final frame
        stereo = samples.reshape(2, -1).astype(np.float32) / 32768.0
        window = stereo.shape[1] / 44100.0
        # Samples arrived: analyse them. A logged decode error with usable
        # output is a bad frame we tolerate, not a failure.
        cls = classify_failure(stderr_text) if stderr_text else Disposition.INCONCLUSIVE
        return (stereo, 44100, 2, window, command, rc, stderr_text, cls)

    # Nothing decoded. The last stderr line is the honest failure reason;
    # classify it so a truly damaged file gets a terminal disposition
    # instead of three identical retries.
    lines = stderr_text.splitlines() if stderr_text else []
    detail = lines[-1] if lines else f"ffmpeg produced no samples (exit {rc})"
    return (None, 44100, 0, 0.0, command, rc, detail,
            classify_failure(detail))


class AudioAnalyzer:
    """
    Enhanced audio analysis using Essentia with TensorFlow models.
    
    Supports two modes:
    - Enhanced: Uses ML models for accurate mood/valence/arousal (default)
    - Standard: Uses heuristics when models aren't available (fallback)
    """
    
    def __init__(self):
        self.enhanced_mode = False
        self.musicnn_model = None  # Base MusiCNN model
        self.prediction_models = {}  # Classification head models
        
        if ESSENTIA_AVAILABLE:
            self._init_essentia()
            self._load_ml_models()
    
    def _init_essentia(self):
        """Initialize Essentia algorithms for basic feature extraction"""
        # Basic feature extractors (always available)
        self.rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
        self.key_extractor = es.KeyExtractor()
        self.loudness = es.Loudness()
        self.dynamic_complexity = es.DynamicComplexity()
        self.danceability_extractor = es.Danceability()
        
        # Additional extractors for better Standard mode
        self.spectral_centroid = es.Centroid(range=22050)  # For brightness
        self.rms = es.RMS()  # For proper energy calculation
        self.spectrum = es.Spectrum()
        self.windowing = es.Windowing(type='hann')
        self.resampler = es.Resample(inputSampleRate=44100, outputSampleRate=16000)

        logger.info("Essentia basic algorithms initialized")
    
    def _load_ml_models(self):
        """Load the MusiCNN embedding model and its classification heads for
        Enhanced mode; without them, analysis runs in Standard mode."""
        if not TF_MODELS_AVAILABLE:
            logger.info("Model files not available - using Standard mode")
            return

        try:
            logger.info("TensorFlow running on CPU")

            from essentia.standard import TensorflowPredict2D, TensorflowPredictMusiCNN
            logger.info("Loading MusiCNN models...")

            # First, load the base MusiCNN embedding model
            if os.path.exists(MODELS['musicnn']):
                try:
                    self.musicnn_model = TensorflowPredictMusiCNN(
                        graphFilename=MODELS['musicnn'],
                        output="model/dense/BiasAdd"  # Embedding layer output
                    )
                    logger.info("Loaded base MusiCNN model for embeddings")
                except Exception as e:
                    logger.warning(f"Failed to load MusiCNN model: {e}")
                    logger.info("Falling back to Standard mode (heuristic-based analysis)")
                    self.enhanced_mode = False
                    return
            else:
                logger.warning(f"Base MusiCNN model not found at: {MODELS['musicnn']}")
                logger.info("This is normal if models haven't been downloaded yet.")
                logger.info("Falling back to Standard mode (heuristic-based analysis)")
                logger.info("Standard mode still provides BPM, key, energy, and mood detection,")
                logger.info("but uses audio features instead of ML predictions.")
                self.enhanced_mode = False
                return
            
            # Load classification head models
            heads_to_load = {
                'mood_happy': MODELS['mood_happy'],
                'mood_sad': MODELS['mood_sad'],
                'mood_relaxed': MODELS['mood_relaxed'],
                'mood_aggressive': MODELS['mood_aggressive'],
                'mood_party': MODELS['mood_party'],
                'mood_acoustic': MODELS['mood_acoustic'],
                'mood_electronic': MODELS['mood_electronic'],
                'danceability': MODELS['danceability'],
                # voice_instrumental excluded: broken head (81% of vocal tracks score 0.9+)
                # CLAP zero-shot in vibe phase is the sole writer for instrumentalness
            }
            
            for model_name, model_path in heads_to_load.items():
                if os.path.exists(model_path):
                    try:
                        self.prediction_models[model_name] = TensorflowPredict2D(
                            graphFilename=model_path,
                            output="model/Softmax"
                        )
                        logger.info(f"Loaded classification head: {model_name}")
                    except Exception as e:
                        logger.warning(f"Failed to load {model_name}: {e}")
                else:
                    logger.warning(f"Model not found: {model_path}")

            # Load valence/arousal regression models (different output layer)
            for va_model in ['deam', 'emomusic']:
                va_path = MODELS.get(va_model)
                if va_path and os.path.exists(va_path):
                    try:
                        self.prediction_models[va_model] = TensorflowPredict2D(
                            graphFilename=va_path,
                            output="model/Identity"
                        )
                        logger.info(f"Loaded {va_model} valence/arousal regression model")
                    except Exception as e:
                        logger.warning(f"Failed to load {va_model} model: {e}")

            # Enable enhanced mode if we have the key mood models
            # (valence and arousal are derived from mood predictions)
            required = ['mood_happy', 'mood_sad', 'mood_relaxed', 'mood_aggressive']
            if all(m in self.prediction_models for m in required):
                self.enhanced_mode = True
                logger.info(f"ENHANCED MODE ENABLED - {len(self.prediction_models)} MusiCNN classification heads loaded")
            else:
                missing = [m for m in required if m not in self.prediction_models]
                logger.warning(f"Missing required models: {missing} - using Standard mode")
                
        except ImportError as e:
            logger.warning(f"TensorflowPredict2D not available: {e}")
            self.enhanced_mode = False
        except Exception as e:
            logger.error(f"Failed to load ML models: {e}")
            traceback.print_exc()
            self.enhanced_mode = False
    
    def load_audio(self, file_path: str, max_duration: int = 90) -> Optional[Any]:
        """Load up to max_duration seconds at 44.1kHz as mono: the stereo
        decode from _decode_to_stereo, averaged to one channel. The decode is
        the only integrity check; a file with a logged bad frame is analysed.
        """
        self._last_load_error = None
        if not ESSENTIA_AVAILABLE:
            return None

        (samples, sample_rate, channels, window,
         command, rc, stderr, cls) = _decode_to_stereo(
            file_path, duration=max_duration)
        if samples is None:
            logger.error(f"Decode failed for {file_path}: {stderr}")
            self._last_load_error = tag_error(stderr, cls, "unknown")
            return None
        if rc != 0:
            # Tolerant decode: samples arrived despite ffmpeg reporting a
            # bad frame -- analyse them, keep the evidence in the log.
            logger.warning(
                f"Decoded {file_path} with errors (rc={rc}): {stderr[-160:]}"
            )
        if samples.ndim == 2:
            return samples.mean(axis=0)
        return samples

    def analyze(self, file_path: str) -> Dict[str, Any]:
        """
        Analyze audio file and extract all features.

        Loads audio once at 44.1kHz, resamples in-memory to 16kHz for ML inference.
        Uses Enhanced mode (ML models) if available, otherwise Standard mode (heuristics).
        """
        result = {
            'bpm': None,
            'beatsCount': None,
            'key': None,
            'keyScale': None,
            'keyStrength': None,
            'energy': None,
            'loudness': None,
            'dynamicRange': None,
            'danceability': None,
            'valence': None,
            'arousal': None,
            'instrumentalness': None,
            'acousticness': None,
            'moodTags': [],
            'moodHappy': None,
            'moodSad': None,
            'moodRelaxed': None,
            'moodAggressive': None,
            'moodParty': None,
            'moodAcoustic': None,
            'moodElectronic': None,
            'danceabilityMl': None,
            'essentiaGenres': [],
            'analysisMode': 'standard',
        }

        if not ESSENTIA_AVAILABLE:
            logger.error("Essentia not available - cannot analyze audio files")
            result['_error'] = 'Essentia library not installed'
            return result

        MAX_ANALYZE_SECONDS = int(os.getenv('MAX_ANALYZE_SECONDS', '90'))
        audio_44k = None
        try:
            audio_44k = self.load_audio(file_path, max_duration=MAX_ANALYZE_SECONDS)
        except MemoryError:
            logger.error(f"MemoryError: Could not load audio for {file_path}")
            result['_error'] = 'MemoryError: audio file too large'
            return result
        if audio_44k is None:
            result['_error'] = getattr(self, '_last_load_error', None) or 'Audio failed to load (corrupt or unreadable)'
            return result

        try:
            # === BASIC FEATURES (always extracted) ===

            # Rhythm Analysis with fallback chain
            try:
                bpm, beats, beats_confidence, _, beats_intervals = self.rhythm_extractor(audio_44k)
                result['bpm'] = round(float(bpm), 1)
                result['beatsCount'] = len(beats)
            except Exception as rhythm_error:
                logger.warning(f"RhythmExtractor2013 failed, using fallback: {rhythm_error}")
                try:
                    onset_detector = es.OnsetRate()
                    onset_rate, _ = onset_detector(audio_44k)
                    bpm = max(60, min(180, onset_rate * 60))
                    result['bpm'] = round(float(bpm), 1)
                    result['beatsCount'] = 0
                    logger.info(f"Fallback BPM estimate: {result['bpm']}")
                except Exception as fallback_error:
                    logger.warning(f"Onset-based fallback also failed: {fallback_error}")
                    # No measured tempo: report none. A fabricated 120 is a
                    # fake answer that would flow into mood maths and the UI.
                    bpm = None
                    result['bpm'] = None
                    result['beatsCount'] = 0

            # Key Detection
            try:
                key, scale, strength = self.key_extractor(audio_44k)
                result['key'] = key
                result['keyScale'] = scale
                result['keyStrength'] = round(float(strength), 3)
            except Exception as key_error:
                logger.warning(f"Key extraction failed: {key_error}")
                # No measured key: report none, never a fabricated C major.
                key = None
                scale = None
                result['key'] = None
                result['keyScale'] = None
                result['keyStrength'] = None

            # Energy & Spectral features - frame-based extraction
            frame_size = 2048
            hop_size = 1024
            n_frames = max(0, (len(audio_44k) - frame_size) // hop_size)

            rms_values = np.empty(n_frames, dtype=np.float32)
            sc_values = np.empty(n_frames, dtype=np.float32)

            for idx in range(n_frames):
                offset = idx * hop_size
                frame = audio_44k[offset:offset + frame_size]
                windowed = self.windowing(frame)
                spectrum = self.spectrum(windowed)

                rms_values[idx] = self.rms(frame)
                sc_values[idx] = self.spectral_centroid(spectrum)

            if n_frames > 0:
                avg_rms = float(np.mean(rms_values))
                result['energy'] = round(min(1.0, avg_rms * 3), 3)
                avg_sc = float(np.mean(sc_values))
            else:
                result['energy'] = 0.5
                avg_sc = 0.5

            loudness = self.loudness(audio_44k)
            result['loudness'] = round(float(loudness), 2)

            dynamic_range, _ = self.dynamic_complexity(audio_44k)
            result['dynamicRange'] = round(float(dynamic_range), 2)

            # Store spectral features for Standard mode estimates
            result['_spectral_centroid'] = avg_sc

            # Basic Danceability (non-ML)
            # Essentia Danceability() returns [0, 3], normalize to [0, 1]
            danceability, _ = self.danceability_extractor(audio_44k)
            result['danceability'] = round(max(0.0, min(1.0, float(danceability) / 3.0)), 3)

            # === ENHANCED MODE: Use ML models ===
            if self.enhanced_mode:
                try:
                    # Resample in-memory instead of re-reading from disk
                    audio_16k = self.resampler(audio_44k)
                    ml_features = self._extract_ml_features(audio_16k)
                    result.update(ml_features)
                    result['analysisMode'] = 'enhanced'
                    logger.info(f"Enhanced analysis: valence={result['valence']}, arousal={result['arousal']}")
                except Exception as e:
                    logger.warning(f"ML analysis failed, falling back to Standard: {e}")
                    traceback.print_exc()
                    self._apply_standard_estimates(result, scale, bpm)
            else:
                self._apply_standard_estimates(result, scale, bpm)

            # Acousticness set by CLAP zero-shot in the vibe phase (not derived from dynamicRange).

            # Generate mood tags based on all features
            result['moodTags'] = self._generate_mood_tags(result)

            logger.info(f"Analysis complete [{result['analysisMode']}]: BPM={result['bpm']}, Key={result['key']} {result['keyScale']}, Valence={result['valence']}, Arousal={result['arousal']}")
        except MemoryError:
            logger.error(f"MemoryError during analysis of {file_path}")
            result['_error'] = 'MemoryError: analysis exceeded memory limits'
        except Exception as e:
            logger.error(f"Analysis error: {e}")
            traceback.print_exc()
        finally:
            result.pop('_spectral_centroid', None)
        return result
    
    def _extract_ml_features(self, audio_16k) -> Dict[str, Any]:
        """Enhanced mode: MusiCNN embeddings fed through the classification
        heads. MusiCNN was trained on pop and rock, so other genres skew; values
        are stored raw and the backend ranks them within each library.
        """
        result = {}
        
        if not self.musicnn_model:
            raise ValueError("MusiCNN model not loaded")
        
        def positive_prob(model_name: str, embeddings) -> Optional[float]:
            """
            Mean per-frame probability of the head's positive class, read from
            the column its metadata names (see HEAD_CLASSES). None when the
            prediction fails -- a missing value, never a made-up neutral one.
            """
            try:
                preds = self.prediction_models[model_name](embeddings)
                raw_value = float(np.mean(preds[:, positive_class_index(model_name)]))
                return round(max(0.0, min(1.0, raw_value)), 3)
            except Exception as e:
                logger.warning(f"Prediction failed for {model_name}: {e}")
                return None

        # Step 1: Get embeddings from base MusiCNN model
        # Output shape: [frames, 200] - 200-dimensional embedding per frame
        embeddings = self.musicnn_model(audio_16k)
        logger.debug(f"MusiCNN embeddings shape: {embeddings.shape}")

        # Step 2: each head is an independent binary classifier, stored raw;
        # the backend (moodBucketService) compares moods within the library.
        mood_heads = {
            'moodHappy': 'mood_happy',
            'moodSad': 'mood_sad',
            'moodRelaxed': 'mood_relaxed',
            'moodAggressive': 'mood_aggressive',
            'moodParty': 'mood_party',
            'moodAcoustic': 'mood_acoustic',
            'moodElectronic': 'mood_electronic',
        }
        for field, head in mood_heads.items():
            if head in self.prediction_models:
                result[field] = positive_prob(head, embeddings)

        logger.info(f"ML Moods: H={result.get('moodHappy')}, S={result.get('moodSad')}, R={result.get('moodRelaxed')}, A={result.get('moodAggressive')}, P={result.get('moodParty')}")

        # === VALENCE & AROUSAL (ensemble of available regression models) ===
        va_models = [m for m in ['deam', 'emomusic'] if m in self.prediction_models]
        if va_models:
            # Each model outputs [frames, 2] = [valence, arousal] in range [1, 9]
            valence_preds = []
            arousal_preds = []
            for model_name in va_models:
                try:
                    preds = self.prediction_models[model_name](embeddings)
                    valence_preds.append(float(np.mean(preds[:, 0])))
                    arousal_preds.append(float(np.mean(preds[:, 1])))
                except Exception as e:
                    logger.warning(f"{model_name} prediction failed: {e}")
            if valence_preds:
                valence_raw = sum(valence_preds) / len(valence_preds)
                arousal_raw = sum(arousal_preds) / len(arousal_preds)
                # Temperature scaling: amplify deviation from center (5.0 in [1,9] space)
                # to spread compressed predictions before normalizing to [0,1]
                center = 5.0
                temperature = 2.5
                valence_scaled = max(1.0, min(9.0, center + (valence_raw - center) * temperature))
                arousal_scaled = max(1.0, min(9.0, center + (arousal_raw - center) * temperature))
                result['valence'] = round(max(0.0, min(1.0, (valence_scaled - 1.0) / 8.0)), 3)
                result['arousal'] = round(max(0.0, min(1.0, (arousal_scaled - 1.0) / 8.0)), 3)
            else:
                self._heuristic_valence_arousal(result)
        else:
            self._heuristic_valence_arousal(result)
        
        # instrumentalness, acousticness: CLAP zero-shot is sole writer (vibe phase).

        # === ML DANCEABILITY ===
        if 'danceability' in self.prediction_models:
            result['danceabilityMl'] = positive_prob('danceability', embeddings)

        return result
    
    def _heuristic_valence_arousal(self, result: Dict[str, Any]):
        """Derive valence/arousal from mood model predictions when V/A regression models are unavailable.
        Leaves them unset if any input head failed, rather than inventing a neutral value."""
        needed = ['moodHappy', 'moodSad', 'moodParty', 'moodAggressive', 'moodElectronic', 'moodRelaxed', 'moodAcoustic']
        if any(result.get(k) is None for k in needed):
            return
        result['valence'] = round(max(0.0, min(1.0,
            result['moodHappy'] * 0.5 + result['moodParty'] * 0.3 + (1 - result['moodSad']) * 0.2)), 3)
        result['arousal'] = round(max(0.0, min(1.0,
            result['moodAggressive'] * 0.35 + result['moodParty'] * 0.25 +
            result['moodElectronic'] * 0.2 + (1 - result['moodRelaxed']) * 0.1 +
            (1 - result['moodAcoustic']) * 0.1)), 3)

    def _apply_standard_estimates(self, result: Dict[str, Any], scale: str, bpm: float):
        """Standard mode: estimate mood from key, BPM, energy, dynamic range,
        and spectral centroid."""
        result['analysisMode'] = 'standard'
        
        # Get all available features
        energy = result.get('energy', 0.5) or 0.5
        dynamic_range = result.get('dynamicRange', 8) or 8
        danceability = result.get('danceability', 0.5) or 0.5
        spectral_centroid = result.get('_spectral_centroid', 0.5) or 0.5
        
        # === VALENCE (happiness/positivity) ===
        # Major key = happier, minor = sadder, unknown key = neutral.
        key_valence = 0.65 if scale == 'major' else (0.35 if scale == 'minor' else 0.5)
        
        # Higher tempo tends to be happier
        bpm_valence = 0.5
        if bpm:
            if bpm >= 120:
                bpm_valence = min(0.8, 0.5 + (bpm - 120) / 200)  # Fast = happy
            elif bpm <= 80:
                bpm_valence = max(0.2, 0.5 - (80 - bpm) / 100)   # Slow = melancholic
        
        # Brighter sounds (high spectral centroid) tend to be happier
        # Spectral centroid is 0-1 (fraction of nyquist)
        brightness_valence = min(1.0, spectral_centroid * 1.5)
        
        # Combine factors (key is most important for valence)
        result['valence'] = round(
            key_valence * 0.4 +      # Key is strong indicator
            bpm_valence * 0.25 +     # Tempo matters
            brightness_valence * 0.2 + # Brightness adds positivity
            energy * 0.15,           # Energy adds slight positivity
            3
        )
        
        # === AROUSAL (energy/intensity) ===
        # BPM is the strongest arousal indicator
        bpm_arousal = 0.5
        if bpm:
            # Map 60-180 BPM to 0.1-0.9 arousal
            bpm_arousal = min(0.9, max(0.1, (bpm - 60) / 140))
        
        # Energy directly indicates intensity
        energy_arousal = energy
        
        # Low dynamic range = compressed = more intense
        compression_arousal = max(0, min(1.0, 1 - (dynamic_range / 20)))
        
        # Brightness adds to perceived energy
        brightness_arousal = min(1.0, spectral_centroid * 1.2)
        
        # Combine factors (BPM and energy are most important)
        result['arousal'] = round(
            bpm_arousal * 0.35 +       # Tempo is key
            energy_arousal * 0.35 +    # Energy/loudness
            brightness_arousal * 0.15 + # Brightness adds energy
            compression_arousal * 0.15, # Compression = intensity
            3
        )

    def _generate_mood_tags(self, features: Dict[str, Any]) -> List[str]:
        """
        Generate mood tags based on extracted features.
        
        In Enhanced mode, uses ML predictions for more accurate tagging.
        In Standard mode, uses heuristic rules.
        """
        tags = []
        
        bpm = features.get('bpm', 0) or 0
        energy = features.get('energy', 0.5) or 0.5
        valence = features.get('valence', 0.5) or 0.5
        arousal = features.get('arousal', 0.5) or 0.5
        danceability = features.get('danceability', 0.5) or 0.5
        key_scale = features.get('keyScale', '')
        
        # Enhanced mode: use ML mood predictions
        mood_happy = features.get('moodHappy')
        mood_sad = features.get('moodSad')
        mood_relaxed = features.get('moodRelaxed')
        mood_aggressive = features.get('moodAggressive')
        
        # ML-based tags (higher confidence)
        if mood_happy is not None and mood_happy >= 0.6:
            tags.append('happy')
            tags.append('uplifting')
        if mood_sad is not None and mood_sad >= 0.6:
            tags.append('sad')
            tags.append('melancholic')
        if mood_relaxed is not None and mood_relaxed >= 0.6:
            tags.append('relaxed')
            tags.append('chill')
        if mood_aggressive is not None and mood_aggressive >= 0.6:
            tags.append('aggressive')
            tags.append('intense')
        
        # Arousal-based tags (prefer ML arousal)
        if arousal >= 0.7:
            tags.append('energetic')
            tags.append('upbeat')
        elif arousal <= 0.3:
            tags.append('calm')
            tags.append('peaceful')
        
        # Valence-based tags (if not already added by ML)
        if 'happy' not in tags and 'sad' not in tags:
            if valence >= 0.7:
                tags.append('happy')
                tags.append('uplifting')
            elif valence <= 0.3:
                tags.append('sad')
                tags.append('melancholic')
        
        # Danceability-based tags
        if danceability >= 0.7:
            tags.append('dance')
            tags.append('groovy')
        
        # BPM-based tags
        if bpm >= 140:
            tags.append('fast')
        elif bpm <= 80:
            tags.append('slow')
        
        # Key-based tags
        if key_scale == 'minor':
            if 'happy' not in tags:
                tags.append('moody')
        
        # Combination tags
        if arousal >= 0.7 and bpm >= 120:
            tags.append('workout')
        if arousal <= 0.4 and valence <= 0.4:
            tags.append('atmospheric')
        if arousal <= 0.3 and bpm <= 90:
            tags.append('chill')
        if mood_aggressive is not None and mood_aggressive >= 0.5 and bpm >= 120:
            tags.append('intense')
        
        return list(set(tags))[:12]  # Dedupe and limit


# Global analyzer instance for worker processes (initialized per-process)
_process_analyzer = None

def _pool_health_check():
    """No-op function for pool health checks (lambdas can't be pickled with spawn mode)."""
    return True


def _init_worker_process():
    """
    Initialize the analyzer for a worker process.
    
    If model loading fails, the analyzer will fall back to Standard mode.
    This prevents worker crashes from breaking the entire process pool.
    """
    global _process_analyzer
    try:
        _process_analyzer = AudioAnalyzer()
        mode = "Enhanced" if _process_analyzer.enhanced_mode else "Standard"
        logger.info(f"Worker process {os.getpid()} initialized with analyzer ({mode} mode)")
    except Exception as e:
        logger.error(f"Worker initialization error: {e}")
        logger.error("This worker will not be able to process tracks.")
        logger.error(f"Traceback: {traceback.format_exc()}")
        # Re-raise to kill this worker - better than silent failures
        raise

def _analyze_track_in_process(args: Tuple[str, str]) -> Tuple[str, str, Dict[str, Any]]:
    """
    Analyze a single track in a worker process.
    Returns (track_id, file_path, features_dict or error_dict)
    """
    global _process_analyzer
    track_id, file_path = args
    
    try:
        # Ensure path is properly decoded (Issue #6 fix)
        if isinstance(file_path, bytes):
            file_path = file_path.decode('utf-8', errors='replace')
        
        # Normalize path separators (Windows paths -> Unix)
        normalized_path = file_path.replace('\\', '/')
        full_path = os.path.join(MUSIC_PATH, normalized_path)
        
        # Use os.fsencode/fsdecode for filesystem-safe encoding
        try:
            full_path = os.fsdecode(os.fsencode(full_path))
        except (UnicodeError, AttributeError):
            return (track_id, file_path, {'_error': 'Invalid characters in file path'})
        
        if not os.path.exists(full_path):
            return (track_id, file_path, {'_error': 'File not found'})

        if os.path.getsize(full_path) == 0:
            return (track_id, file_path, {'_error': 'Empty file (0 bytes) - likely incomplete download'})

        # Run analysis
        features = _process_analyzer.analyze(full_path)
        return (track_id, file_path, features)
        
    except UnicodeDecodeError as e:
        logger.error(f"UTF-8 decoding error for track {track_id}: {e}")
        return (track_id, file_path, {'_error': f'UTF-8 encoding error: {e}'})
    except Exception as e:
        logger.error(f"Analysis error for {file_path}: {e}")
        return (track_id, file_path, {'_error': str(e)})


class AnalysisWorker:
    """Worker that processes audio analysis jobs from Redis queue using parallel processing"""
    

    def __init__(self):
        self.redis = redis.from_url(REDIS_URL)
        self.db = DatabaseConnection(DATABASE_URL)
        self.running = False
        self.executor = None
        self.pool_active = False
        self.consecutive_empty = 0
        self.is_paused = False  # Enrichment control: pause state
        self.pubsub = None  # Redis pub/sub for control signals
        self._last_work_time = time.time()
        self._pending_resize: int | None = None
        self._pending_resize_time: float = 0.0
        self._setup_control_channel()
    
    def _setup_control_channel(self):
        """Subscribe to control channel for pause/resume/stop signals"""
        try:
            self.pubsub = self.redis.pubsub()
            self.pubsub.subscribe(CONTROL_CHANNEL)
            logger.info(f"Subscribed to control channel: {CONTROL_CHANNEL}")
        except Exception as e:
            logger.warning(f"Failed to subscribe to control channel: {e}")
            self.pubsub = None
    
    def _is_gate_closed(self) -> bool:
        """Check the synchronous Redis gate key set by Node.js.
        Returns True if Python should NOT process work.
        This is the authoritative stop signal -- no pub/sub timing dependency.
        Also syncs local is_paused flag to match gate state."""
        try:
            val = self.redis.get("audio:analysis:gate")
            if val and (val == b"paused" or val == "paused"):
                if not self.is_paused:
                    self.is_paused = True
                    logger.info("Gate closed by Node.js -- pausing")
                return True
            else:
                if self.is_paused:
                    # Gate is open but we're still paused -- Node.js has resumed
                    self.is_paused = False
                    logger.info("Gate opened by Node.js -- resuming")
                return False
        except Exception:
            return False

    def _check_control_signals(self):
        """Check for pause/resume/stop/set_workers control signals (non-blocking)"""
        if not self.pubsub:
            return
        
        try:
            message = self.pubsub.get_message(ignore_subscribe_messages=True, timeout=0.001)
            if message and message['type'] == 'message':
                data = message['data'].decode('utf-8') if isinstance(message['data'], bytes) else message['data']
                
                # Try to parse as JSON for structured commands
                try:
                    cmd = json.loads(data)
                    if isinstance(cmd, dict) and cmd.get('command') == 'set_workers':
                        new_count = int(cmd.get('count', NUM_WORKERS))
                        new_count = max(1, min(8, new_count))
                        if new_count != NUM_WORKERS:
                            self._pending_resize = new_count
                            self._pending_resize_time = time.time()
                            logger.info(f"Worker resize queued: {NUM_WORKERS} -> {new_count} (applying in {RESIZE_DEBOUNCE_SECONDS}s)")
                        return
                except (json.JSONDecodeError, ValueError):
                    pass  # Not JSON, try as plain string
                
                # Handle plain string signals (pause/resume/stop)
                logger.info(f"Received control signal: {data}")
                
                if data == 'pause':
                    self.is_paused = True
                    logger.info("Audio analysis PAUSED")
                elif data == 'resume':
                    self.is_paused = False
                    logger.info("Audio analysis RESUMED")
                elif data == 'stop':
                    self.running = False
                    logger.info("Audio analysis STOPPING (graceful shutdown)")
        except Exception as e:
            logger.warning(f"Error checking control signals: {e}")
    
    def _apply_pending_resize(self):
        """Apply buffered resize if debounce period has elapsed."""
        if self._pending_resize is None:
            return
        elapsed = time.time() - self._pending_resize_time
        if elapsed < RESIZE_DEBOUNCE_SECONDS:
            return
        target = self._pending_resize
        self._pending_resize = None
        self._resize_worker_pool(target)

    def _resize_worker_pool(self, new_count: int):
        """
        Resize the worker pool to a new count.
        Gracefully completes in-flight work before resizing.
        """
        global NUM_WORKERS
        
        if new_count == NUM_WORKERS:
            logger.info(f"Worker count unchanged at {new_count}")
            return
        
        logger.info(f"Resizing worker pool: {NUM_WORKERS} -> {new_count} workers")
        
        old_executor = self.executor
        NUM_WORKERS = new_count
        
        # Create new pool first
        self.executor = ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process,
            **_pool_recycle_kwargs(50),
        )
        
        # Gracefully shutdown old pool (wait for in-flight work)
        if old_executor:
            try:
                old_executor.shutdown(wait=True)
            except Exception as e:
                logger.warning(f"Error shutting down old pool: {e}")
        
        logger.info(f"Worker pool resized to {NUM_WORKERS} workers")
    
    def _check_pool_health(self) -> bool:
        """
        Check if the process pool is still healthy.
        Returns False if pool is broken or workers are dead.
        """
        if self.executor is None:
            return False
        
        # Check if pool is explicitly marked as broken
        if hasattr(self.executor, '_broken') and self.executor._broken:
            return False
        
        # Try a no-op submission to verify pool works
        try:
            future = self.executor.submit(_pool_health_check)
            result = future.result(timeout=5)
            return result is True
        except Exception:
            return False
    
    def _ensure_pool(self):
        """Lazily start or verify the process pool is running."""
        if self.pool_active and self.executor is not None:
            return
        if self.executor is not None:
            # Stale executor reference, clean it up
            try:
                self.executor.shutdown(wait=False)
            except Exception:
                pass
        logger.info(f"Starting worker pool with {NUM_WORKERS} processes...")
        self.executor = ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process,
            **_pool_recycle_kwargs(50),
        )
        self.pool_active = True
        logger.info(f"Worker pool started ({NUM_WORKERS} workers)")

    def _shutdown_pool(self):
        """Shut down the process pool to free memory during idle periods."""
        if not self.pool_active or self.executor is None:
            return
        logger.info("No pending work -- shutting down worker pool to free memory")
        try:
            self.executor.shutdown(wait=True)
        except Exception as e:
            logger.warning(f"Error during pool shutdown: {e}")
        self.executor = None
        self.pool_active = False
        gc.collect()
        # Force glibc to return freed pages to OS (Python/PyTorch hold RSS otherwise)
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
        logger.info("Worker pool shut down (will restart when work arrives)")

    def _recreate_pool(self):
        """
        Safely terminate the broken pool and create a new one.
        This is the critical recovery mechanism for Issue #21.
        """
        logger.warning("Recreating process pool due to broken workers...")

        # Attempt graceful shutdown first
        if self.executor:
            try:
                self.executor.shutdown(wait=False)
            except Exception as e:
                logger.warning(f"Error during executor shutdown: {e}")
            self.executor = None
            self.pool_active = False

        # Small delay to allow cleanup
        time.sleep(2)

        # Create fresh pool
        self._ensure_pool()
        logger.info(f"Process pool recreated with {NUM_WORKERS} workers")
    
    def start(self):
        """Start processing jobs with BRPOP-driven event loop"""
        cpu_count = os.cpu_count() or 4

        logger.info("=" * 60)
        logger.info("Starting Audio Analysis Worker (BRPOP MODE)")
        logger.info("=" * 60)
        logger.info(f"  Music path: {MUSIC_PATH}")
        logger.info(f"  Batch size: {BATCH_SIZE}")
        logger.info(f"  CPU cores: {cpu_count}")
        logger.info(f"  Worker processes: {NUM_WORKERS}")
        logger.info(f"  BRPOP timeout: {BRPOP_TIMEOUT}s")
        logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
        logger.info(f"  Essentia available: {ESSENTIA_AVAILABLE}")
        logger.info(f"  ML models on disk: {TF_MODELS_AVAILABLE}")
        logger.info(f"  Worker pool: LAZY (starts on first job)")

        self.db.connect()
        self.running = True

        # The TrackStage record owns each attempt: a claim from before a crash
        # expires and comes around again, and a lost queue entry is re-offered
        # by the next dispatch.

        try:
            while self.running:
                try:
                    # Publish heartbeat
                    try:
                        self.redis.set("audio:worker:heartbeat", str(int(time.time() * 1000)))
                    except Exception:
                        pass

                    # Check for control signals (pause/resume/stop/set_workers)
                    self._check_control_signals()
                    self._apply_pending_resize()
                    # Sync pause state from Redis gate (authoritative, no pub/sub dependency)
                    self._is_gate_closed()

                    if self.is_paused:
                        logger.debug("Audio analysis paused, waiting for resume signal...")
                        time.sleep(1)
                        continue

                    # BRPOP-driven: blocks until work arrives or timeout
                    has_work = self.process_batch_parallel()

                    if has_work:
                        self.consecutive_empty = 0
                        self._last_work_time = time.time()
                    else:
                        self.consecutive_empty += 1

                        # Unload models when idle: immediately if DB has no pending
                        # work, or after MODEL_IDLE_TIMEOUT as a fallback
                        if self.pool_active:
                            idle_seconds = time.time() - self._last_work_time
                            if idle_seconds >= MODEL_IDLE_TIMEOUT:
                                self._shutdown_pool()
                                logger.info(f"Models idle for {idle_seconds:.0f}s, pool shut down")
                            elif idle_seconds >= BRPOP_TIMEOUT:
                                # No pending work in DB and queue empty -- unload now
                                self._shutdown_pool()
                                logger.info("All work complete, pool shut down (will restart when work arrives)")

                except KeyboardInterrupt:
                    logger.info("Shutdown requested")
                    self.running = False
                except BrokenProcessPool:
                    logger.error("BrokenProcessPool detected, recreating pool...")
                    self._recreate_pool()
                    continue
                except Exception as e:
                    logger.error(f"Worker error: {e}")
                    traceback.print_exc()
                    self.consecutive_empty += 1

                    if self.consecutive_empty >= 5:
                        logger.info("Multiple consecutive errors, attempting recovery...")
                        try:
                            self.db.close()
                            time.sleep(2)
                            self.db.connect()
                            if self.pool_active and not self._check_pool_health():
                                self._recreate_pool()
                        except Exception as reconnect_err:
                            logger.error(f"Recovery failed: {reconnect_err}")
                        self.consecutive_empty = 0

                    time.sleep(BRPOP_TIMEOUT)
        finally:
            self._shutdown_pool()
            if self.pubsub:
                self.pubsub.close()
                logger.info("Control channel closed")
            self.db.close()
            logger.info("Worker stopped")
    
    def process_batch_parallel(self) -> bool:
        """Block on BRPOP for the first job, drain up to BATCH_SIZE more, and
        process them in parallel. Returns False if BRPOP timed out."""
        if self._is_gate_closed():
            return False

        result = self.redis.brpop(ANALYSIS_QUEUE, timeout=BRPOP_TIMEOUT)

        if result is None:
            return False

        _, first_job_data = result
        first_job = json.loads(first_job_data)
        queued_jobs = [(first_job['trackId'], first_job.get('filePath', ''))]

        while len(queued_jobs) < BATCH_SIZE:
            job_data = self.redis.lpop(ANALYSIS_QUEUE)
            if not job_data:
                break
            job = json.loads(job_data)
            queued_jobs.append((job['trackId'], job.get('filePath', '')))

        self._process_tracks_parallel(queued_jobs)
        return True
    
    def _mark_track_processing(self, track_id: str) -> bool:
        """Claim a track just before its worker starts, keyed on analysis
        status alone. 'failed' is included because the stage record, not the
        column, decides whether a track is asked again. Returns True if claimed.
        """
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET "analysisStatus" = 'processing',
                    "analysisStartedAt" = %s
                WHERE id = %s
                  AND "analysisStatus" IN ('pending', 'queued', 'failed')
            """, (datetime.now(timezone.utc), track_id))
            claimed = cursor.rowcount > 0

            self.db.commit()
            return claimed
        except Exception as e:
            logger.error(f"Failed to mark track {track_id} as processing: {e}")
            self.db.rollback()
            return False
        finally:
            cursor.close()

    def _process_tracks_parallel(self, tracks: List[Tuple[str, str]]):
        """Process multiple tracks in parallel using the process pool"""
        if not tracks:
            return

        self._ensure_pool()
        logger.info(f"Processing batch of {len(tracks)} tracks with {NUM_WORKERS} workers...")

        # Mark tracks processing individually as they are submitted
        start_time = time.time()
        completed = 0
        failed = 0

        futures = {}
        for t in tracks:
            if not self._mark_track_processing(t[0]):
                logger.debug(f"Track {t[0]} already claimed, skipping")
                continue
            futures[self.executor.submit(_analyze_track_in_process, t)] = t

        try:
            for future in as_completed(futures, timeout=900):
                try:
                    track_id, file_path, features = future.result(timeout=180)

                    if features.get('_error'):
                        self._save_failed(track_id, features['_error'])
                        failed += 1
                        logger.error(f"✗ Failed: {file_path} - {features['_error']}")
                    else:
                        self._save_results(track_id, file_path, features)
                        completed += 1
                        logger.info(f"✓ Completed: {file_path}")
                except BrokenProcessPool:
                    # Worker died (OOM, segfault) -- not the track's fault
                    track_info = futures[future]
                    self._save_failed(track_info[0], "Worker process died (OOM/crash)", is_timeout=True)
                    failed += 1
                    logger.error(f"✗ Worker death (no penalty): {track_info[1]}")
                except Exception as e:
                    track_info = futures[future]
                    is_pool_death = "abruptly terminated" in str(e) or "broken" in str(e).lower()
                    self._save_failed(track_info[0], f"Timeout or error: {e}", is_timeout=is_pool_death)
                    failed += 1
                    if is_pool_death:
                        logger.error(f"✗ Worker death (no penalty): {track_info[1]} - {e}")
                    else:
                        logger.error(f"✗ Failed: {track_info[1]} - {e}")
        except BrokenProcessPool:
            # Pool broke during iteration -- all remaining futures are innocent
            logger.error("BrokenProcessPool during batch -- resetting remaining tracks without penalty")
            for future, track_info in futures.items():
                if not future.done():
                    future.cancel()
                    self._save_failed(track_info[0], "Worker pool crashed (OOM/crash)", is_timeout=True)
                    failed += 1
                    logger.error(f"✗ Pool crash (no penalty): {track_info[1]}")
            self._recreate_pool()
        except (TimeoutError, FuturesTimeoutError):
            # On Python < 3.11 concurrent.futures.TimeoutError is a distinct
            # class from the builtin, so the batch timeout must be caught by
            # both names or the 3.8 image silently loses this whole branch.
            for future, track_info in futures.items():
                if not future.done():
                    future.cancel()
                    self._save_failed(track_info[0], "Batch timeout: analysis exceeded 15 minutes", is_timeout=True)
                    failed += 1
                    logger.error(f"✗ Batch timeout (no penalty): {track_info[1]}")
            # Restart the pool to evict any stuck worker processes
            try:
                self.executor.shutdown(wait=False)
            except Exception:
                pass
            self.executor = None
            self.pool_active = False

        elapsed = time.time() - start_time
        rate = len(tracks) / elapsed if elapsed > 0 else 0
        logger.info(f"Batch complete: {completed} succeeded, {failed} failed in {elapsed:.1f}s ({rate:.1f} tracks/sec)")
    
    def _save_results(self, track_id: str, file_path: str, features: Dict[str, Any]):
        """Save analysis results. instrumentalness and acousticness are left
        alone: CLAP is their only writer, and a re-analysis would null them."""
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET
                    bpm = %s,
                    "beatsCount" = %s,
                    key = %s,
                    "keyScale" = %s,
                    "keyStrength" = %s,
                    energy = %s,
                    loudness = %s,
                    "dynamicRange" = %s,
                    danceability = %s,
                    valence = %s,
                    arousal = %s,
                    "moodTags" = %s,
                    "essentiaGenres" = %s,
                    "moodHappy" = %s,
                    "moodSad" = %s,
                    "moodRelaxed" = %s,
                    "moodAggressive" = %s,
                    "moodParty" = %s,
                    "moodAcoustic" = %s,
                    "moodElectronic" = %s,
                    "danceabilityMl" = %s,
                    "analysisMode" = %s,
                    "analysisStatus" = 'completed',
                    "analysisStartedAt" = NULL,
                    "analysisVersion" = %s,
                    "analyzedAt" = %s,
                    "analysisError" = NULL
                WHERE id = %s AND "analysisStatus" = 'processing'
            """, (
                features['bpm'],
                features['beatsCount'],
                features['key'],
                features['keyScale'],
                features['keyStrength'],
                features['energy'],
                features['loudness'],
                features['dynamicRange'],
                features['danceability'],
                features['valence'],
                features['arousal'],
                features['moodTags'],
                features['essentiaGenres'],
                features.get('moodHappy'),
                features.get('moodSad'),
                features.get('moodRelaxed'),
                features.get('moodAggressive'),
                features.get('moodParty'),
                features.get('moodAcoustic'),
                features.get('moodElectronic'),
                features.get('danceabilityMl'),
                features.get('analysisMode', 'standard'),
                ESSENTIA_VERSION,
                datetime.now(timezone.utc),
                track_id
            ))
            if cursor.rowcount == 0:
                logger.warning(f"Track {track_id} was reset by cleanup before save completed, skipping")
                self.db.rollback()
                return
            # Settle the analysis stage record: the claim left attempt untouched,
            # so it advances by one, matching the jobId (track-<id>-analysis-<attempt+1>).
            cursor.execute("""
                INSERT INTO "TrackStage"
                    (id, "trackId", stage, status, source, attempt,
                     "lastErrorCode", "lastErrorMessage", "failureClass",
                     retryable, "nextRetryAt", evidence, "startedAt",
                     "finishedAt", "decidedAt", "decidedBy")
                VALUES (
                    md5(%s || ':analysis'), %s, 'analysis', 'done', 'analyzer',
                    COALESCE((SELECT attempt + 1 FROM "TrackStage"
                              WHERE "trackId" = %s AND stage = 'analysis'), 1),
                    NULL, NULL, NULL, false, NULL, %s::jsonb,
                    (SELECT "startedAt" FROM "TrackStage"
                     WHERE "trackId" = %s AND stage = 'analysis'),
                    %s, now(), 'engine')
                ON CONFLICT ("trackId", stage) DO UPDATE
                    SET status = 'done',
                        attempt = EXCLUDED.attempt,
                        "lastErrorCode" = NULL,
                        "lastErrorMessage" = NULL,
                        "failureClass" = NULL,
                        retryable = false,
                        "nextRetryAt" = NULL,
                        evidence = EXCLUDED.evidence,
                        "finishedAt" = EXCLUDED."finishedAt",
                        "decidedAt" = now(),
                        "decidedBy" = 'engine'
            """, (
                track_id, track_id, track_id,
                json.dumps({"analysisMode": features.get('analysisMode', 'standard'),
                            "essentiaVersion": ESSENTIA_VERSION}),
                track_id,
                datetime.now(timezone.utc),
            ))

            self.db.commit()

            # The backend queues the vibe embedding job on this event.
            try:
                completion_event = json.dumps({
                    "trackId": track_id,
                    "filePath": file_path,
                    "status": "complete",
                })
                self.redis.publish("audio:analysis:complete", completion_event)
                logger.debug(f"[Essentia] Published completion for track {track_id}")
            except Exception as pub_err:
                logger.warning(f"[Essentia] Failed to publish completion event for {track_id}: {pub_err}")

        except Exception as e:
            logger.error(f"Failed to save results for {track_id}: {e}")
            self.db.rollback()
        finally:
            cursor.close()
    
    def _save_failed(self, track_id: str, error: str, is_timeout: bool = False):
        """Every failure lands here and is classified. DAMAGED, UNSUPPORTED and
        MULTICANNEL are terminal; INCONCLUSIVE retries on the shared ladder up
        to STAGE_RETRY_CAP; a batch timeout returns to pending with no penalty.
        The TrackStage record and the Track column are written in one transaction.
        """
        disp, codec = classify_with_codec(error)
        cursor = self.db.get_cursor()
        try:
            # INCONCLUSIVE needs the record's current attempt first, as the
            # backend's recordStageFailure does.
            inconclusive_retryable = False
            inconclusive_wait_seconds = None
            inconclusive_attempt = 0
            record_closed = False
            if disp == Disposition.INCONCLUSIVE:
                cursor.execute("""
                    SELECT attempt, retryable, status FROM "TrackStage"
                     WHERE "trackId" = %s AND stage = 'analysis'
                """, (track_id,))
                row = cursor.fetchone()
                current_attempt = (row.get("attempt") or 0) if row else 0
                inconclusive_attempt = current_attempt + 1
                # A closed record is never reopened; only the column is settled.
                record_closed = bool(row) and row.get("status") == "failed" and not row.get("retryable")
                inconclusive_retryable = (
                    not record_closed
                    and inconclusive_attempt < STAGE_RETRY_CAP
                )
                inconclusive_wait_seconds = (
                    compute_stage_retry_wait_seconds(inconclusive_attempt)
                    if inconclusive_retryable else None
                )

            if is_timeout:
                cursor.execute("""
                    UPDATE "Track"
                    SET
                        "analysisStatus" = 'pending',
                        "analysisError" = %s,
                        "analysisStartedAt" = NULL
                    WHERE id = %s AND "analysisStatus" = 'processing'
                """, (error[:500], track_id))
            elif disp == Disposition.INCONCLUSIVE and (record_closed or not inconclusive_retryable):
                # At the cap, or on a closed record, the column turns terminal
                # to match the record.
                cursor.execute("""
                    UPDATE "Track"
                    SET
                        "analysisStatus" = 'permanently_failed',
                        "analysisError" = %s,
                        "analysisStartedAt" = NULL
                    WHERE id = %s AND "analysisStatus" = 'processing'
                """, (error[:500], track_id))
            elif disp == Disposition.INCONCLUSIVE:
                cursor.execute("""
                    UPDATE "Track"
                    SET
                        "analysisStatus" = 'failed',
                        "analysisError" = %s,
                        "analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1
                    WHERE id = %s AND "analysisStatus" = 'processing'
                """, (error[:500], track_id))
            else:
                # Terminal: the answer is decided; do not spend another
                # attempt on it and do not spend a retry on it either.
                cursor.execute("""
                    UPDATE "Track"
                    SET
                        "analysisStatus" = 'permanently_failed',
                        "analysisError" = %s,
                        "analysisStartedAt" = NULL
                    WHERE id = %s AND "analysisStatus" = 'processing'
                """, (tag_error(error, disp, codec)[:500], track_id))

            if cursor.rowcount == 0:
                logger.warning(f"Track {track_id} was reset by cleanup before failure marked, skipping")
                self.db.rollback()
                return

            # Terminal answers close the record; INCONCLUSIVE stays due after a
            # backoff; a timeout reopens it as pending without spending an attempt.
            if is_timeout:
                cursor.execute("""
                    INSERT INTO "TrackStage"
                        (id, "trackId", stage, status, source, attempt,
                         "lastErrorCode", "lastErrorMessage", "failureClass",
                         retryable, "nextRetryAt", evidence, "startedAt",
                         "finishedAt", "decidedAt", "decidedBy")
                    VALUES (
                        md5(%s || ':analysis'), %s, 'analysis', 'pending', 'analyzer',
                        COALESCE((SELECT attempt FROM "TrackStage"
                                  WHERE "trackId" = %s AND stage = 'analysis'), 0),
                        NULL, %s, NULL, true,
                        now() + interval '2 minutes', %s::jsonb,
                        NULL, NULL, now(), 'engine')
                    ON CONFLICT ("trackId", stage) DO UPDATE
                        SET status = 'pending',
                            "lastErrorCode" = NULL,
                            "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                            "failureClass" = NULL,
                            retryable = true,
                            "nextRetryAt" = EXCLUDED."nextRetryAt",
                            evidence = EXCLUDED.evidence,
                            "startedAt" = NULL,
                            "finishedAt" = NULL,
                            "decidedAt" = now(),
                            "decidedBy" = 'engine'
                """, (
                    track_id, track_id, track_id,
                    error[:500],
                    json.dumps({"timeout": True, "error": error[:500]}),
                ))
            elif disp == Disposition.INCONCLUSIVE and record_closed:
                pass  # a closed record is left as it is
            elif disp == Disposition.INCONCLUSIVE:
                # Retryable below STAGE_RETRY_CAP with nextRetryAt on the ladder;
                # NULL once the cap closes the record.
                cursor.execute("""
                    INSERT INTO "TrackStage"
                        (id, "trackId", stage, status, source, attempt,
                         "lastErrorCode", "lastErrorMessage", "failureClass",
                         retryable, "nextRetryAt", evidence, "startedAt",
                         "finishedAt", "decidedAt", "decidedBy")
                    VALUES (
                        md5(%s || ':analysis'), %s, 'analysis', 'failed', 'analyzer',
                        %s,
                        NULL, %s, %s, %s,
                        CASE WHEN %s::int IS NULL THEN NULL
                             ELSE now() + (%s::int * interval '1 second') END,
                        %s::jsonb,
                        NULL, now(), now(), 'engine')
                    ON CONFLICT ("trackId", stage) DO UPDATE
                        SET status = 'failed',
                            attempt = EXCLUDED.attempt,
                            "lastErrorCode" = NULL,
                            "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                            "failureClass" = EXCLUDED."failureClass",
                            retryable = EXCLUDED.retryable,
                            "nextRetryAt" = EXCLUDED."nextRetryAt",
                            evidence = EXCLUDED.evidence,
                            "startedAt" = NULL,
                            "finishedAt" = now(),
                            "decidedAt" = now(),
                            "decidedBy" = 'engine'
                """, (
                    track_id, track_id,
                    inconclusive_attempt,
                    error[:500],
                    'INCONCLUSIVE',
                    inconclusive_retryable,
                    inconclusive_wait_seconds,
                    inconclusive_wait_seconds,
                    json.dumps({"error": error[:500]}),
                ))
            else:
                cursor.execute("""
                    INSERT INTO "TrackStage"
                        (id, "trackId", stage, status, source, attempt,
                         "lastErrorCode", "lastErrorMessage", "failureClass",
                         retryable, "nextRetryAt", evidence, "startedAt",
                         "finishedAt", "decidedAt", "decidedBy")
                    VALUES (
                        md5(%s || ':analysis'), %s, 'analysis', 'failed', 'analyzer',
                        COALESCE((SELECT attempt + 1 FROM "TrackStage"
                                  WHERE "trackId" = %s AND stage = 'analysis'), 1),
                        %s, %s, %s, false,
                        NULL, %s::jsonb,
                        NULL, now(), now(), 'engine')
                    ON CONFLICT ("trackId", stage) DO UPDATE
                        SET status = 'failed',
                            attempt = EXCLUDED.attempt,
                            "lastErrorCode" = EXCLUDED."lastErrorCode",
                            "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                            "failureClass" = EXCLUDED."failureClass",
                            retryable = false,
                            "nextRetryAt" = NULL,
                            evidence = EXCLUDED.evidence,
                            "startedAt" = NULL,
                            "finishedAt" = now(),
                            "decidedAt" = now(),
                            "decidedBy" = 'engine'
                """, (
                    track_id, track_id, track_id,
                    disp,
                    tag_error(error, disp, codec)[:500],
                    disp,
                    json.dumps({"error": error[:500], "codec": codec}),
                ))

            if is_timeout:
                logger.info(f"Track {track_id} reset to pending (batch timeout, no penalty)")
            elif disp == Disposition.INCONCLUSIVE:
                if record_closed:
                    logger.warning(
                        f"Track {track_id} analysis record already closed; "
                        f"left closed (attempt stays {inconclusive_attempt})"
                    )
                elif inconclusive_retryable:
                    logger.info(
                        f"Track {track_id} failed (attempt "
                        f"{inconclusive_attempt}/{STAGE_RETRY_CAP}, retry in "
                        f"{inconclusive_wait_seconds}s)"
                    )
                else:
                    logger.warning(
                        f"Track {track_id} closed terminally after "
                        f"{inconclusive_attempt} inconclusive attempts "
                        f"(cap {STAGE_RETRY_CAP})"
                    )
            else:
                logger.warning(f"Track {track_id} marked permanently_failed ({disp}, source {codec}) -- {error[:160]}")

            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            self.db.rollback()
        finally:
            cursor.close()


def main():
    """Main entry point"""
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Test mode: analyze a single file
        if len(sys.argv) < 3:
            print("Usage: analyzer.py --test <audio_file>")
            sys.exit(1)
        
        analyzer = AudioAnalyzer()
        result = analyzer.analyze(sys.argv[2])
        print(json.dumps(result, indent=2))
        return
    
    # Normal worker mode
    worker = AnalysisWorker()
    worker.start()


if __name__ == '__main__':
    main()

