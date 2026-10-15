package com.opus.piano

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewmodel.compose.viewModel
import com.opus.piano.ui.*

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val model: OpusViewModel = viewModel(factory = viewModelFactory {
                initializer { OpusViewModel((application as OpusApplication).repository, createSavedStateHandle()) }
            })
            val catalog: CatalogViewModel = viewModel(factory = viewModelFactory {
                initializer { CatalogViewModel((application as OpusApplication).catalogRepository, createSavedStateHandle()) }
            })
            val experience: ExperienceViewModel = viewModel(factory = viewModelFactory {
                initializer { ExperienceViewModel((application as OpusApplication).achievements, (application as OpusApplication).recordings) }
            })
            OpusTheme { OpusApp(model, catalog, experience) }
        }
    }
}
