package com.opus.piano.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

enum class LearningStatus(val label: String) { PLANNED("To learn"), LEARNING("Learning"), POLISHING("Polishing"), READY("Performance ready") }
enum class Difficulty(val label: String) { UNRATED("Not assessed"), BEGINNER("Beginner"), INTERMEDIATE("Intermediate"), ADVANCED("Advanced"), EXPERT("Expert") }

@Entity(tableName = "pieces", indices = [Index(value = ["catalogWorkId"], unique = true)])
data class Piece(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val composer: String,
    val difficulty: Difficulty = Difficulty.INTERMEDIATE,
    val status: LearningStatus = LearningStatus.PLANNED,
    val notes: String = "",
    val catalogWorkId: String? = null
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
    @Query("SELECT * FROM pieces WHERE catalogWorkId = :id LIMIT 1") suspend fun catalogPiece(id: String): Piece?
    @Query("SELECT * FROM pieces") suspend fun allPieces(): List<Piece>
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertCatalogPiece(piece: Piece): Long
    @Upsert suspend fun save(piece: Piece)
    @Delete suspend fun delete(piece: Piece)
    @Insert suspend fun insert(session: PracticeSession)
}
@Database(entities = [Piece::class, PracticeSession::class, CatalogComposer::class, CatalogWork::class, CatalogCache::class], version = 2, exportSchema = true)
@TypeConverters(Converters::class)
abstract class OpusDatabase : RoomDatabase() {
    abstract fun dao(): OpusDao
    abstract fun catalogDao(): CatalogDao
    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE pieces ADD COLUMN catalogWorkId TEXT")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_pieces_catalogWorkId ON pieces(catalogWorkId)")
                db.execSQL("CREATE TABLE IF NOT EXISTS catalog_composers (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, birth TEXT NOT NULL, death TEXT NOT NULL, epoch TEXT NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS catalog_works (id TEXT NOT NULL PRIMARY KEY, composerId TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL, genre TEXT NOT NULL, searchTerms TEXT NOT NULL, catalogue TEXT NOT NULL, catalogueNumber TEXT NOT NULL, musicalKey TEXT NOT NULL)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_catalog_works_composerId ON catalog_works(composerId)")
                db.execSQL("CREATE TABLE IF NOT EXISTS catalog_cache (cacheKey TEXT NOT NULL PRIMARY KEY, payload TEXT NOT NULL, fetchedAt INTEGER NOT NULL)")
            }
        }
    }
}
class OpusRepository(private val dao: OpusDao) {
    val pieces = dao.observePieces()
    val sessions = dao.observeSessions()
    suspend fun save(piece: Piece) = dao.save(piece)
    suspend fun delete(piece: Piece) = dao.delete(piece)
    suspend fun complete(session: PracticeSession) = dao.insert(session)
}
