package com.opus.piano.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow

enum class LearningStatus(val label: String) { PLANNED("To learn"), LEARNING("Learning"), POLISHING("Polishing"), READY("Performance ready") }
enum class Difficulty(val label: String) { BEGINNER("Beginner"), INTERMEDIATE("Intermediate"), ADVANCED("Advanced"), EXPERT("Expert") }

@Entity(tableName = "pieces")
data class Piece(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val composer: String,
    val difficulty: Difficulty = Difficulty.INTERMEDIATE,
    val status: LearningStatus = LearningStatus.PLANNED,
    val notes: String = ""
)

// Snapshot titles preserve meaningful history when a repertoire piece is edited or deleted.
@Entity(tableName = "sessions")
data class PracticeSession(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val pieceId: Long?,
    val pieceTitle: String,
    val startedAt: Long,
    val completedAt: Long,
    val durationMillis: Long
)
class Converters {
    @TypeConverter fun status(value: String) = LearningStatus.valueOf(value)
    @TypeConverter fun status(value: LearningStatus) = value.name
    @TypeConverter fun difficulty(value: String) = Difficulty.valueOf(value)
    @TypeConverter fun difficulty(value: Difficulty) = value.name
}
@Dao
interface OpusDao {
    @Query("SELECT * FROM pieces ORDER BY title COLLATE NOCASE") fun observePieces(): Flow<List<Piece>>
    @Query("SELECT * FROM sessions ORDER BY completedAt DESC") fun observeSessions(): Flow<List<PracticeSession>>
    @Upsert suspend fun save(piece: Piece)
    @Delete suspend fun delete(piece: Piece)
    @Insert suspend fun insert(session: PracticeSession)
}
@Database(entities = [Piece::class, PracticeSession::class], version = 1, exportSchema = true)
@TypeConverters(Converters::class)
abstract class OpusDatabase : RoomDatabase() { abstract fun dao(): OpusDao }
class OpusRepository(private val dao: OpusDao) {
    val pieces = dao.observePieces()
    val sessions = dao.observeSessions()
    suspend fun save(piece: Piece) = dao.save(piece)
    suspend fun delete(piece: Piece) = dao.delete(piece)
    suspend fun complete(session: PracticeSession) = dao.insert(session)
}
