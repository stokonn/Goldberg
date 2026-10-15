package com.opus.piano.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.opus.piano.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.*

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ProfileScreen(state: LibraryState, badges: List<BadgeProgress>, profile: ProfileViewModel, model: OpusViewModel, badgeDetail: (String) -> Unit) {
    val settings by profile.settings.collectAsStateWithLifecycle()
    val busy by profile.busy.collectAsStateWithLifecycle()
    val preview by profile.preview.collectAsStateWithLifecycle()
    var name by rememberSaveable(settings.username) { mutableStateOf(settings.username) }
    var period by rememberSaveable { mutableStateOf("Week") }
    var manage by rememberSaveable { mutableStateOf(false) }
    var limit by rememberSaveable { mutableIntStateOf(20) }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { it?.let(profile::avatar) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { it?.let(profile::export) }
    val restore = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(profile::inspect) }
    val avatar by produceState<android.graphics.Bitmap?>(null, settings.avatar) {
        value = withContext(Dispatchers.Default) { runCatching {
            val bytes = android.util.Base64.decode(settings.avatar, android.util.Base64.DEFAULT)
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull() }
    }
    val today = LocalDate.now()
    val zone = ZoneId.systemDefault()
    val filtered = remember(state.sessions, period, today) {
        val from = when (period) { "Week" -> today.minusDays(6); "Month" -> today.minusDays(29); "Year" -> today.minusDays(364); else -> LocalDate.MIN }
        state.sessions.filter { AchievementEngine.recordedDay(it, zone) in from..today }
    }
    val totals = remember(filtered, state.parts) { attributedSessions(filtered, state.parts).groupBy { it.catalogWorkId?.let { id -> "catalog:$id" } ?: it.pieceId?.let { id -> "piece:$id" } ?: "free" }.values.map { entries -> entries.first().pieceTitle to entries.sumOf { it.durationMillis } }.sortedByDescending { it.second }.take(5) }
    val currentStreak = remember(state.sessions, today) {
        val days = state.sessions.filter(AchievementEngine::valid).map { AchievementEngine.recordedDay(it, zone) }.toSet()
        var day = if (today in days) today else today.minusDays(1); var count = 0
        while (day in days) { count++; day = day.minusDays(1) }; count
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Heading("GOLDBERG · A NEW ERA", "Profile", "Your music, your progress, your journal.") }
        item { Panel {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Surface(Modifier.size(80.dp), shape = MaterialTheme.shapes.large) {
                    if (avatar != null) Image(avatar!!.asImageBitmap(), "Your avatar", contentScale = ContentScale.Crop)
                    else Icon(Icons.Outlined.Person, "Default avatar", Modifier.padding(16.dp))
                }
                Column { Text(settings.username, style = MaterialTheme.typography.titleLarge); TextButton(onClick = { photo.launch("image/*") }, enabled = !busy) { Text("Choose avatar") } }
            }
            if (settings.avatar.isNotBlank()) TextButton(onClick = profile::clearAvatar, enabled = !busy) { Text("Use default avatar") }
            OutlinedTextField(name, { name = it.take(80) }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Button(onClick = { profile.username(name) }, enabled = !busy && name.trim() != settings.username) { Text("Save username") }
        } }
        item { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Week", "Month", "Year", "All time").forEach { label -> FilterChip(period == label, { period = label; limit = 20 }, label = { Text(label) }) }
        } }
        item { Panel {
            Text("${duration(filtered.sumOf { it.durationMillis })} practiced · $period", style = MaterialTheme.typography.titleLarge)
            Text("Lifetime practice: ${duration(state.sessions.sumOf { it.durationMillis })}")
            Text("${state.pieces.size} repertoire pieces · ${filtered.size} sessions in this period")
            Text("$currentStreak day current streak · ${badges.count { it.unlocked }} achievements")
        } }
        item { ActivityChart(filtered, period) }
        item { SectionTitle("Badge showcase (${settings.badgeIds.size}/5)")
            TextButton(onClick = { manage = !manage }) { Text(if (manage) "Done editing showcase" else "Choose & reorder badges") }
        }
        if (settings.badgeIds.isEmpty()) item { Text("Choose up to five unlocked badges to display here.") }
        items(settings.badgeIds, key = { "showcase:$it" }) { id ->
            val badge = badges.firstOrNull { it.definition.id == id && it.unlocked }
            if (badge != null) Panel {
                TextButton(onClick = { badgeDetail(id) }) { MedalArtwork(badge, Modifier.size(48.dp)); Spacer(Modifier.width(12.dp)); Text(badge.definition.name) }
                if (manage) FlowRow {
                    val index = settings.badgeIds.indexOf(id)
                    TextButton(enabled = index > 0 && !busy, onClick = { val ids = settings.badgeIds.toMutableList(); java.util.Collections.swap(ids, index, index - 1); profile.showcase(ids) }) { Text("Move earlier") }
                    TextButton(enabled = index < settings.badgeIds.lastIndex && !busy, onClick = { val ids = settings.badgeIds.toMutableList(); java.util.Collections.swap(ids, index, index + 1); profile.showcase(ids) }) { Text("Move later") }
                    TextButton(enabled = !busy, onClick = { profile.showcase(settings.badgeIds - id) }) { Text("Remove") }
                }
            }
        }
        if (manage) items(badges.filter { it.unlocked && it.definition.id !in settings.badgeIds }, key = { "choose:${it.definition.id}" }) { badge ->
            OutlinedButton(onClick = { profile.showcase(settings.badgeIds + badge.definition.id) }, enabled = settings.badgeIds.size < 5 && !busy) { Text("Showcase ${badge.definition.name}") }
        }
        item { SectionTitle("Most practiced · $period") }
        items(totals) { (title, time) -> Panel { Text(title); Text(duration(time), color = MaterialTheme.colorScheme.primary) } }
        if (totals.isEmpty()) item { Text("No practice in this period yet.") }
        item { SectionTitle("Session history · $period") }
        items(filtered.take(limit), key = { "session:${it.id}" }) { SessionRow(it, state.parts.filter { p -> p.sessionId == it.id }) }
        if (filtered.size > limit) item { OutlinedButton(onClick = { limit += 20 }) { Text("Show older sessions") } }
        item { Panel {
            SectionTitle("Appearance")
            Choice("Theme", listOf("System", "Light", "Dark"), settings.theme) { if (!busy) profile.theme(it) }
            Text("Typography follows your device font size. Motion follows Android animation settings.", style = MaterialTheme.typography.bodySmall)
        } }
        item { Panel {
            SectionTitle("Backup & restore")
            Text("Export a local copy before replacing data. A restore replaces the journal, profile and cached catalogue with the selected backup.")
            Button(onClick = { export.launch("Goldberg-backup.json") }, enabled = !busy) { Text("Export backup") }
            OutlinedButton(onClick = { restore.launch(arrayOf("application/json", "text/plain", "application/octet-stream")) }, enabled = !busy) { Text("Select backup to restore") }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        } }
        item { Text("Goldberg 0.6.0 · A New Era", style = MaterialTheme.typography.labelSmall) }
    }
    preview?.let { summary ->
        val timer by model.timer.collectAsStateWithLifecycle()
        AlertDialog(onDismissRequest = profile::cancelRestore, title = { Text("Replace this device’s journal?") }, text = { Text("$summary\n\nAll current saved data will be replaced. Export a backup first. Any active timer will be discarded after a successful restore.${if (timer.elapsed > 0 || timer.running) " You have an unfinished session." else ""}") },
        confirmButton = { TextButton(enabled = !busy, onClick = { profile.restore(model::reset) }) { Text("Replace & restore") } }, dismissButton = { TextButton(enabled = !busy, onClick = profile::cancelRestore) { Text("Cancel") } }) }
}

@Composable private fun ActivityChart(sessions: List<PracticeSession>, period: String) {
    val bins = remember(sessions, period) { activityBins(sessions, period, LocalDate.now(), ZoneId.systemDefault()) }
    val peak = (bins.maxOfOrNull { it.second } ?: 0).coerceAtLeast(60000)
    Panel {
        SectionTitle("Practice activity · $period")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            bins.forEach { (label, time) -> Column(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = "$label: ${time / 60000} minutes" }, horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.height(88.dp).fillMaxWidth(), contentAlignment = Alignment.BottomCenter) { Box(Modifier.fillMaxWidth().height((2 + 86 * time.toFloat() / peak).dp).background(MaterialTheme.colorScheme.primary, MaterialTheme.shapes.small)) }
                Text(if (period == "Year") label.takeLast(2) else label.takeLast(5), style = MaterialTheme.typography.labelSmall, maxLines = 2)
            } }
        }
    }
}
