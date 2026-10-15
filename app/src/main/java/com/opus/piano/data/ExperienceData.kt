package com.opus.piano.data

import androidx.room.*
import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "saved_recordings", indices = [Index("workKey")])
data class SavedRecording(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val workKey: String,
    val url: String,
    val title: String = "",
    val performer: String = "",
    val platform: String,
    val savedAt: Long,
    val preferred: Boolean = false
)
@Entity(tableName = "badge_unlocks")
data class BadgeUnlock(@PrimaryKey val achievementId: String, val unlockedAt: Long)

@Dao
interface ExperienceDao {
    @Query("SELECT * FROM saved_recordings ORDER BY preferred DESC, savedAt DESC") fun recordings(): Flow<List<SavedRecording>>
    @Query("SELECT * FROM saved_recordings WHERE workKey = :key") suspend fun recordingsFor(key: String): List<SavedRecording>
    @Query("SELECT * FROM saved_recordings WHERE id = :id") suspend fun recording(id: Long): SavedRecording?
    @Upsert suspend fun saveRecording(recording: SavedRecording)
    @Query("UPDATE saved_recordings SET preferred = 0 WHERE workKey = :key") suspend fun clearPreferred(key: String)
    @Query("UPDATE saved_recordings SET preferred = 1 WHERE id = :id") suspend fun prefer(id: Long)
    @Query("DELETE FROM saved_recordings WHERE id = :id") suspend fun removeRecording(id: Long)
    @Query("SELECT * FROM badge_unlocks ORDER BY unlockedAt DESC, achievementId") fun unlocks(): Flow<List<BadgeUnlock>>
    @Query("SELECT * FROM badge_unlocks") suspend fun allUnlocks(): List<BadgeUnlock>
    // No UPDATE/REPLACE method: the first verified unlock timestamp is immutable.
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun unlock(unlocks: List<BadgeUnlock>)
}

class RecordingRepository(private val db: OpusDatabase) {
    private val dao = db.experienceDao()
    val recordings = dao.recordings()
    suspend fun save(input: SavedRecording) = db.withTransaction {
        val valid = RecordingLinks.validate(input.url) ?: throw IllegalArgumentException("Use a valid HTTPS recording or score URL from Spotify, YouTube, IMSLP or MuseScore.")
        val old = if (input.id > 0) dao.recording(input.id) ?: throw IllegalArgumentException("This saved interpretation no longer exists.") else null
        val key = old?.workKey ?: input.workKey
        require(key.matches(Regex("(catalog|piece):[0-9]+"))) { "This composition is unavailable." }
        require(dao.recordingsFor(key).none { it.id != input.id && it.url == valid.url }) { "This link is already saved for this composition." }
        if (input.preferred) dao.clearPreferred(key)
        dao.saveRecording(input.copy(workKey = key, url = valid.url, platform = valid.platform.name,
            title = input.title.trim(), performer = input.performer.trim(), savedAt = old?.savedAt ?: System.currentTimeMillis()))
    }
    suspend fun prefer(id: Long) = db.withTransaction {
        val recording = dao.recording(id) ?: throw IllegalArgumentException("This saved interpretation no longer exists.")
        dao.clearPreferred(recording.workKey); dao.prefer(id)
    }
    suspend fun remove(id: Long) = dao.removeRecording(id)
}
