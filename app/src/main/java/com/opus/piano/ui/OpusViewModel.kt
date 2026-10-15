package com.opus.piano.ui

import android.os.SystemClock
import androidx.lifecycle.*
import com.opus.piano.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class LibraryState(val pieces: List<Piece> = emptyList(), val sessions: List<PracticeSession> = emptyList(), val loading: Boolean = true)
data class TimerState(val elapsed: Long = 0, val running: Boolean = false, val selected: Piece? = null, val saving: Boolean = false)

class OpusViewModel(private val repository: OpusRepository, private val saved: SavedStateHandle) : ViewModel() {
    val library = combine(repository.pieces, repository.sessions) { pieces, sessions -> LibraryState(pieces, sessions, false) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), LibraryState())
    private val _timer = MutableStateFlow(TimerState(
        elapsed = saved["elapsed"] ?: 0L,
        selected = saved.get<Long>("pieceId")?.let { id -> Piece(id, saved["pieceTitle"] ?: "", "") }
    ))
    val timer = _timer.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()
    private var accumulated = _timer.value.elapsed
    private var runStart = 0L
    private var sessionStart: Long = saved["sessionStart"] ?: 0L
    init {
        // Restore interrupted process as paused; never count time while the process was dead.
        viewModelScope.launch {
            while (true) {
                delay(200)
                if (_timer.value.running) {
                    _timer.update { it.copy(elapsed = accumulated + SystemClock.elapsedRealtime() - runStart) }
                    saved["elapsed"] = _timer.value.elapsed
                }
            }
        }
    }
    fun select(piece: Piece?) {
        if (_timer.value.elapsed > 0 || _timer.value.running || _timer.value.saving) return
        _timer.update { it.copy(selected = piece) }
        saved["pieceId"] = piece?.id
        saved["pieceTitle"] = piece?.title
    }
    fun toggle() {
        if (_timer.value.saving) return
        if (_timer.value.running) {
            accumulated += SystemClock.elapsedRealtime() - runStart
            _timer.update { it.copy(elapsed = accumulated, running = false) }
            saved["elapsed"] = accumulated
        } else {
            if (sessionStart == 0L) { sessionStart = System.currentTimeMillis(); saved["sessionStart"] = sessionStart }
            runStart = SystemClock.elapsedRealtime()
            _timer.update { it.copy(running = true) }
        }
    }
    fun reset() {
        if (_timer.value.saving) return
        accumulated = 0; sessionStart = 0
        saved["elapsed"] = 0L; saved["sessionStart"] = 0L
        _timer.update { it.copy(elapsed = 0, running = false) }
    }
    fun finish() {
        if (_timer.value.saving) return
        if (_timer.value.running) toggle()
        val snapshot = _timer.value
        if (snapshot.elapsed < 1000) { _message.value = "Practice for at least one second before saving."; return }
        _timer.update { it.copy(saving = true) }
        viewModelScope.launch {
            try {
                repository.complete(PracticeSession(pieceId = snapshot.selected?.id, pieceTitle = snapshot.selected?.title ?: "Free practice", startedAt = sessionStart, completedAt = System.currentTimeMillis(), durationMillis = snapshot.elapsed))
                _timer.update { it.copy(saving = false) }; reset()
                _message.value = "Session saved. Every minute matters."
            } catch (_: Exception) { _timer.update { it.copy(saving = false) }; _message.value = "Could not save session. Your timer is preserved; please try again." }
        }
    }
    fun save(piece: Piece, done: (Boolean) -> Unit) = viewModelScope.launch {
        try { repository.save(piece.copy(title = piece.title.trim(), composer = piece.composer.trim(), notes = piece.notes.trim())); done(true) }
        catch (_: Exception) { _message.value = "Could not save piece. Please try again."; done(false) }
    }
    fun delete(piece: Piece) = viewModelScope.launch {
        try { repository.delete(piece) } catch (_: Exception) { _message.value = "Could not delete piece. Please try again." }
    }
    fun dismissMessage() { _message.value = null }
}
