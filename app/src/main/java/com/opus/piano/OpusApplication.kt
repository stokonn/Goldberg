package com.opus.piano

import android.app.Application
import androidx.room.Room
import com.opus.piano.data.*

class OpusApplication : Application() {
    val database by lazy {
        Room.databaseBuilder(this, OpusDatabase::class.java, "opus.db")
            .addMigrations(OpusDatabase.MIGRATION_1_2).build()
    }
    val repository by lazy { OpusRepository(database.dao()) }
    val catalogRepository by lazy { CatalogRepository(database, filesDir) }
}
