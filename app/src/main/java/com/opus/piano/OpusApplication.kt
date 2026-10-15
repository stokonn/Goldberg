package com.opus.piano

import android.app.Application
import androidx.room.Room
import com.opus.piano.data.*

class OpusApplication : Application() {
    val repository by lazy {
        OpusRepository(Room.databaseBuilder(this, OpusDatabase::class.java, "opus.db").build().dao())
    }
}
