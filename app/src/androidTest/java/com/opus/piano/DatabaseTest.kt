package com.opus.piano

import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.opus.piano.data.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DatabaseTest {
    @Test fun repertoireCrudAndHistorySurviveReopening() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "opus-test-${System.nanoTime()}.db"
        var db = Room.databaseBuilder(context, OpusDatabase::class.java, name).build()
        try {
            db.dao().save(Piece(title = "Nocturne", composer = "Chopin"))
            val piece = db.dao().observePieces().first().single()
            db.dao().save(piece.copy(status = LearningStatus.POLISHING, notes = "Shape the left hand"))
            assertEquals(LearningStatus.POLISHING, db.dao().observePieces().first().single().status)
            db.dao().insert(PracticeSession(pieceId = piece.id, pieceTitle = piece.title, startedAt = 1000, completedAt = 61000, durationMillis = 60000))
            db.close()
            db = Room.databaseBuilder(context, OpusDatabase::class.java, name).build()
            assertEquals("Shape the left hand", db.dao().observePieces().first().single().notes)
            assertEquals(60000L, db.dao().observeSessions().first().single().durationMillis)
            db.dao().delete(piece)
            assertTrue(db.dao().observePieces().first().isEmpty())
            assertEquals("Nocturne", db.dao().observeSessions().first().single().pieceTitle)
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
