package com.opus.piano

import android.app.Application
import androidx.room.Room
import com.opus.piano.data.*
import kotlinx.coroutines.*

class OpusApplication : Application() {
    val database by lazy {
        Room.databaseBuilder(this, OpusDatabase::class.java, "opus.db")
            .addMigrations(OpusDatabase.MIGRATION_1_2, OpusDatabase.MIGRATION_2_3).build()
    }
    val achievements by lazy { AchievementStore(database) }
    val recordings by lazy { RecordingRepository(database) }
    val repository by lazy { OpusRepository(database, achievements) }
    val catalogRepository by lazy { CatalogRepository(database, filesDir, achievements = achievements) }
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    override fun onCreate() {
        super.onCreate()
        applicationScope.launch {
            try { achievements.evaluate() }
            catch (_: Exception) { /* The Badges screen exposes a retry; never block practice on initial evaluation. */ }
        }
    }
}
