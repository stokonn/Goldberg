package com.opus.piano.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.*
import com.opus.piano.data.*
import java.time.*
import java.time.format.DateTimeFormatter

private enum class Destination(val label: String, val icon: ImageVector) {
    HOME("Home", Icons.Outlined.Home), REPERTOIRE("Repertoire", Icons.Outlined.LibraryMusic),
    PRACTICE("Practice", Icons.Outlined.Piano), QUESTS("Quests", Icons.Outlined.EmojiEvents), WRAPPED("Wrapped", Icons.Outlined.Insights)
}
@Composable fun OpusApp(model: OpusViewModel, catalog: CatalogViewModel) {
    val context = LocalContext.current
    val motionScale by produceState(1f, context) {
        val resolver = context.contentResolver
        val observer = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                value = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
            }
        }
        value = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        awaitDispose { resolver.unregisterContentObserver(observer) }
    }
    val library by model.library.collectAsStateWithLifecycle()
    val timer by model.timer.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val current = entry?.destination?.route ?: Destination.HOME.name
    val catalogNotice by catalog.notice.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); model.dismissMessage() } }
    LaunchedEffect(catalogNotice) { catalogNotice?.let { snackbar.showSnackbar(it); catalog.dismissNotice() } }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
                Destination.entries.forEach { destination ->
                    NavigationBarItem(colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = Gold, selectedTextColor = Gold,
                        indicatorColor = Gold.copy(alpha = .12f),
                        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant), selected = current == destination.name || (destination == Destination.REPERTOIRE && current.startsWith("catalog")), onClick = {
                        nav.navigate(destination.name) { popUpTo(nav.graph.startDestinationId) { saveState = true }; launchSingleTop = true; restoreState = true }
                    }, icon = { Icon(destination.icon, contentDescription = null) }, label = { Text(destination.label, fontSize = 10.sp, maxLines = 1) })
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.widthIn(max = 840.dp).fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Piano, null, tint = Gold, modifier = Modifier.size(22.dp))
                Text("  OPUS", style = MaterialTheme.typography.titleLarge, letterSpacing = 5.sp, color = Ivory)
                Text("THE PRACTICE JOURNAL", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 20.dp))
            }
            NavHost(navController = nav, startDestination = Destination.HOME.name, modifier = Modifier.widthIn(max = 840.dp).fillMaxSize(),
                enterTransition = { fadeIn(tween(if (motionScale == 0f) 0 else 220)) }, exitTransition = { fadeOut(tween(if (motionScale == 0f) 0 else 150)) }) {
                composable(Destination.HOME.name) { Home(library) { nav.navigate(Destination.PRACTICE.name) { launchSingleTop = true } } }
                composable(Destination.REPERTOIRE.name) { Repertoire(library, model, { nav.navigate("catalog") { launchSingleTop = true } }, { nav.navigate("catalog/work/$it") }) }
                composable("catalog") { CatalogScreen(catalog, library, { nav.popBackStack() }, { nav.navigate("catalog/composer/$it") }, { nav.navigate("catalog/work/$it") }) }
                composable("catalog/composer/{id}") { route -> ComposerScreen(route.arguments?.getString("id").orEmpty(), catalog, library, { nav.popBackStack() }, { nav.navigate("catalog/work/$it") }) }
                composable("catalog/work/{id}") { route -> WorkScreen(route.arguments?.getString("id").orEmpty(), catalog, library, { nav.popBackStack() }, { nav.navigate("catalog/composer/$it") }) }
                composable(Destination.PRACTICE.name) { Practice(library, timer, model, motionScale != 0f) }
                composable(Destination.QUESTS.name) { ComingSoon(library, "Quests", "A little progress,\nevery day.", "Build a practice habit that lasts. Personal goals, achievements, XP and levels are coming in a future phase.", Icons.Outlined.EmojiEvents, listOf("Practice goals", "Milestones & achievements", "XP & pianist levels")) }
                composable(Destination.WRAPPED.name) { ComingSoon(library, "Wrapped", "Your music.\nYour story.", "A thoughtful look back at your time at the piano. Monthly and yearly insights are coming in a future phase.", Icons.Outlined.Insights, listOf("Monthly reflections", "Your year at the piano", "Repertoire highlights")) }
            }
        }
    }
}
@Composable internal fun Heading(eyebrow: String, title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelSmall, color = Gold)
        Text(title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable internal fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(24.dp), border = BorderStroke(1.dp, Gold.copy(alpha = .09f)), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}
@Composable internal fun SectionTitle(title: String) { Text(title, style = MaterialTheme.typography.titleLarge) }
private fun duration(millis: Long): String {
    val seconds = millis / 1000
    return "%02d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
}
private fun dayOf(timestamp: Long): LocalDate = Instant.ofEpochMilli(timestamp).atZone(ZoneId.systemDefault()).toLocalDate()
@Composable private fun Home(state: LibraryState, practice: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item { Heading("The art of showing up", "A little closer\nto the music.", LocalDate.now().format(DateTimeFormatter.ofPattern("EEEE, d MMMM"))) }
        if (state.loading) { item { LinearProgressIndicator(Modifier.fillMaxWidth()) }; return@LazyColumn }
        item {
            Surface(shape = RoundedCornerShape(24.dp)) {
                Column(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.surface))).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("AT THE PIANO TODAY", style = MaterialTheme.typography.labelSmall, color = Gold)
                    val today = state.sessions.filter { dayOf(it.completedAt) == LocalDate.now() }.sumOf { it.durationMillis }
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text("${today / 60000}", fontSize = 60.sp, fontFamily = FontFamily.Serif)
                        Text("  minutes", Modifier.padding(bottom = 10.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("A quiet moment. A meaningful practice.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = practice) { Icon(Icons.Outlined.PlayArrow, null); Spacer(Modifier.width(6.dp)); Text("Begin practice") }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Panel(Modifier.weight(1f)) { Text("${state.pieces.size}", style = MaterialTheme.typography.headlineMedium, color = Gold); Text("In repertoire", style = MaterialTheme.typography.bodySmall) }
                Panel(Modifier.weight(1f)) { Text("${state.sessions.size}", style = MaterialTheme.typography.headlineMedium, color = Gold); Text("Sessions completed", style = MaterialTheme.typography.bodySmall) }
            }
        }
        item { WeeklyActivity(state.sessions) }
        item { SectionTitle("Recently practiced repertoire") }
        val recentPieces = state.sessions.mapNotNull { session -> state.pieces.firstOrNull { it.id == session.pieceId } }.distinctBy { it.id }.take(3)
        if (recentPieces.isEmpty()) item { Text("Your practiced pieces will appear here after a saved session.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(recentPieces, key = { "recent-${it.id}" }) { piece -> Panel { Text(piece.title, style = MaterialTheme.typography.titleLarge); Text(piece.composer, color = MaterialTheme.colorScheme.onSurfaceVariant); PieceProgress(piece) } }
        item { SectionTitle("Your repertoire, in motion") }
        item { Panel {
            val ready = state.pieces.count { it.status == LearningStatus.READY }
            Text("$ready of ${state.pieces.size} performance ready")
            LinearProgressIndicator(progress = { if (state.pieces.isEmpty()) 0f else ready.toFloat() / state.pieces.size }, modifier = Modifier.fillMaxWidth())
            Text(if (state.pieces.isEmpty()) "Add your first piece in Repertoire to begin your collection." else "${state.pieces.count { it.status == LearningStatus.LEARNING || it.status == LearningStatus.POLISHING }} pieces actively taking shape.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        } }
        item { SectionTitle("Recent activity") }
        if (state.sessions.isEmpty()) item { Panel { Text("Your first session is a fresh beginning."); Text("Start the timer when you sit down at the piano.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        items(state.sessions.take(5), key = { it.id }) { SessionRow(it) }
        item { Spacer(Modifier.height(8.dp)) }
    }
}
@Composable private fun SessionRow(session: PracticeSession) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.MusicNote, null, tint = Gold)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(session.pieceTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(Instant.ofEpochMilli(session.completedAt).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM · HH:mm")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(duration(session.durationMillis), color = Gold, style = MaterialTheme.typography.labelLarge)
        }
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun Repertoire(state: LibraryState, model: OpusViewModel, explore: () -> Unit, workDetail: (String) -> Unit) {
    var editingId by rememberSaveable { mutableStateOf<Long?>(null) }
    var editorOpen by rememberSaveable { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<Piece?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("All") }
    var sortComposer by rememberSaveable { mutableStateOf(false) }
    val pieces = state.pieces.filter { (filter == "All" || it.status.label == filter) && (catalogText(it.title).contains(catalogText(query)) || catalogText(it.composer).contains(catalogText(query))) }
        .let { if (sortComposer) it.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { p -> p.composer }) else it }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Heading("Your personal collection", "Repertoire", "From first notes to a piece that feels like home.") }
        item { Panel {
            Text("YOUR NEXT MOVEMENT", style = MaterialTheme.typography.labelSmall, color = Gold)
            SectionTitle("Discover classical music")
            Text("Explore composers and works from Open Opus, then add a piece to your collection.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = explore) { Icon(Icons.Outlined.TravelExplore, null); Spacer(Modifier.width(8.dp)); Text("Browse catalogue") }
        } }
        item { Button(onClick = { editingId = null; editorOpen = true }) { Icon(Icons.Outlined.Add, null); Text(" Add piece") } }
        item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Search title or composer") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Choice("Status", listOf("All") + LearningStatus.entries.map { it.label }, filter) { filter = it }
                TextButton(onClick = { sortComposer = !sortComposer }) { Icon(Icons.AutoMirrored.Outlined.Sort, null); Text(if (sortComposer) " Sorted by composer" else " Sorted by title") }
            }
        }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        else if (pieces.isEmpty()) item { Panel { Icon(Icons.Outlined.LibraryMusic, null, tint = Gold); SectionTitle(if (state.pieces.isEmpty()) "A collection waiting to grow" else "No pieces found"); Text(if (state.pieces.isEmpty()) "Add a piece you love. Give it time and make it yours." else "Try another search or status filter.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        items(pieces, key = { it.id }) { piece ->
            Panel(Modifier.animateItem()) {
                Row {
                    Column(Modifier.weight(1f)) {
                        Text(piece.title, style = MaterialTheme.typography.titleLarge)
                        Text(piece.composer, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { editingId = piece.id; editorOpen = true }) { Icon(Icons.Outlined.Edit, "Edit ${piece.title}") }
                    IconButton(onClick = { deleting = piece }) { Icon(Icons.Outlined.DeleteOutline, "Delete ${piece.title}") }
                }
                PieceProgress(piece)
                piece.catalogWorkId?.let { id -> TextButton(onClick = { workDetail(id) }) { Text("View catalogue detail") } }
                Text(piece.difficulty.label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                if (piece.notes.isNotBlank()) Text(piece.notes, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    if (editorOpen) PieceEditor(state.pieces.firstOrNull { it.id == editingId }, { editorOpen = false }) { piece, done -> model.save(piece, done) }
    deleting?.let { piece -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete piece?") }, text = { Text("Remove “${piece.title}” from your repertoire? Completed practice sessions will remain in your history.") }, confirmButton = { TextButton(onClick = { model.delete(piece); deleting = null }) { Text("Delete") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("Keep piece") } }) }
}
@Composable private fun Choice(label: String, options: List<String>, selected: String, choose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }) { Text("$label: $selected"); Icon(Icons.Outlined.ExpandMore, null) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option -> DropdownMenuItem(text = { Text(option) }, onClick = { choose(option); expanded = false }) }
        }
    }
}
@Composable private fun PieceEditor(piece: Piece?, dismiss: () -> Unit, save: (Piece, (Boolean) -> Unit) -> Unit) {
    var title by rememberSaveable { mutableStateOf(piece?.title ?: "") }
    var composer by rememberSaveable { mutableStateOf(piece?.composer ?: "") }
    var notes by rememberSaveable { mutableStateOf(piece?.notes ?: "") }
    var difficulty by rememberSaveable { mutableStateOf(piece?.difficulty ?: Difficulty.INTERMEDIATE) }
    var status by rememberSaveable { mutableStateOf(piece?.status ?: LearningStatus.PLANNED) }
    var saving by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = { if (!saving) dismiss() }) {
        Surface(shape = RoundedCornerShape(24.dp)) {
            Column(Modifier.imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("YOUR REPERTOIRE", style = MaterialTheme.typography.labelSmall, color = Gold)
                SectionTitle(if (piece == null) "A new beginning" else "Refine the details")
                OutlinedTextField(title, { title = it }, label = { Text("Title *") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(composer, { composer = it }, label = { Text("Composer *") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Choice("Difficulty", Difficulty.entries.map { it.label }, difficulty.label) { label -> difficulty = Difficulty.entries.first { it.label == label } }
                Choice("Status", LearningStatus.entries.map { it.label }, status.label) { label -> status = LearningStatus.entries.first { it.label == label } }
                OutlinedTextField(notes, { notes = it }, label = { Text("Notes (optional)") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                Text("* Required", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = dismiss, enabled = !saving) { Text("Cancel") }
                    Button(enabled = title.isNotBlank() && composer.isNotBlank() && !saving, onClick = {
                        saving = true
                        save(Piece(piece?.id ?: 0, title, composer, difficulty, status, notes, piece?.catalogWorkId)) { success ->
                            saving = false
                            if (success) dismiss()
                        }
                    }) { Text("Save piece") }
                }
            }
        }
    }
}
@Composable private fun Practice(library: LibraryState, timer: TimerState, model: OpusViewModel, motion: Boolean) {
    var resetDialog by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Heading("One note at a time", "Practice", "Be present. Let the rest fall quiet.")
        Panel {
            var expanded by remember { mutableStateOf(false) }
            Text("TODAY’S FOCUS", style = MaterialTheme.typography.labelSmall, color = Gold)
            Box {
                OutlinedButton(onClick = { expanded = true }, enabled = timer.elapsed == 0L && !timer.running && !timer.saving) { Text(timer.selected?.title ?: "Free practice", maxLines = 1, overflow = TextOverflow.Ellipsis); Icon(Icons.Outlined.ExpandMore, null) }
                DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                    DropdownMenuItem(text = { Text("Free practice") }, onClick = { model.select(null); expanded = false })
                    library.pieces.forEach { piece -> DropdownMenuItem(text = { Text("${piece.title} · ${piece.composer}") }, onClick = { model.select(piece); expanded = false }) }
                }
            }
            if (timer.elapsed > 0) Text("Focus is locked until this session is saved or discarded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Panel {
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
                PracticeDial(timer, motion)
                Button(onClick = model::toggle, enabled = !timer.saving, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Icon(if (timer.running) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null)
                    Text(if (timer.running) " Pause" else if (timer.elapsed > 0) " Resume" else " Start practice")
                }
                OutlinedButton(onClick = model::finish, enabled = timer.elapsed >= 1000 && !timer.saving, modifier = Modifier.fillMaxWidth()) { Text(if (timer.saving) "Saving…" else "Finish & save session") }
                if (timer.elapsed > 0 || timer.running) TextButton(onClick = { resetDialog = true }, enabled = !timer.saving) { Text("Discard session") }
            }
        }
        Text("Time for scales, a tricky passage, or simply playing something you love. Your completed sessions stay on this device.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        if (library.sessions.isNotEmpty()) { SectionTitle("Last session"); SessionRow(library.sessions.first()) }
    }
    if (resetDialog) AlertDialog(onDismissRequest = { resetDialog = false }, title = { Text("Discard this session?") }, text = { Text("The current timer will be reset without saving.") }, confirmButton = { TextButton(onClick = { model.reset(); resetDialog = false }) { Text("Discard") } }, dismissButton = { TextButton(onClick = { resetDialog = false }) { Text("Keep practicing") } })
}
@Composable private fun ComingSoon(library: LibraryState, eyebrow: String, title: String, description: String, icon: ImageVector, features: List<String>) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
        Heading(eyebrow, title, description)
        if (eyebrow == "Quests") {
            Panel {
                Text("THE PIANIST’S JOURNEY", style = MaterialTheme.typography.labelSmall, color = Gold)
                Text("Every great performance\nbegins with a small step.", style = MaterialTheme.typography.headlineMedium)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Level —", color = Gold)
                    Text("— / — XP", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                LinearProgressIndicator(progress = { 0f }, modifier = Modifier.fillMaxWidth(), trackColor = Gold.copy(alpha = .12f))
                Text("Preview · Levels and XP are not active yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            Panel {
                Text("A REFLECTION IN NUMBERS", style = MaterialTheme.typography.labelSmall, color = Gold)
                Text("The hours become\nsomething beautiful.", style = MaterialTheme.typography.headlineMedium)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    Column(Modifier.weight(1f)) { Text("—", style = MaterialTheme.typography.headlineLarge, color = Gold); Text("Hours at the piano", style = MaterialTheme.typography.bodySmall) }
                    Column(Modifier.weight(1f)) { Text("—", style = MaterialTheme.typography.headlineLarge, color = Gold); Text("Pieces explored", style = MaterialTheme.typography.bodySmall) }
                }
                HorizontalDivider(color = Gold.copy(alpha = .18f))
                Text("Preview · Your monthly and yearly charts will appear when Wrapped is available.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (eyebrow == "Wrapped" && !library.loading) {
            Text("RECORDED ON THIS DEVICE", style = MaterialTheme.typography.labelSmall, color = Gold)
            WeeklyActivity(library.sessions)
        }
        Panel {
            Icon(icon, null, tint = Gold, modifier = Modifier.padding(vertical = 16.dp).size(40.dp))
            Text("COMING IN A FUTURE MOVEMENT", style = MaterialTheme.typography.labelSmall, color = Gold)
            features.forEach { feature -> Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Outlined.RadioButtonUnchecked, null, tint = Gold, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(12.dp)); Text(feature) } }
        }
        if (eyebrow == "Quests") {
            listOf("The first movement" to "Begin a lasting practice habit.", "A familiar melody" to "Return to the pieces you love.").forEach { (name, detail) ->
                Panel {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Icon(Icons.Outlined.Lock, null, tint = Gold, modifier = Modifier.size(28.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(name, style = MaterialTheme.typography.titleLarge)
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("COMING SOON", style = MaterialTheme.typography.labelSmall, color = Gold)
                        }
                    }
                }
            }
        }
        Text("For now, make music. Your practice sessions are already being saved for the journey ahead.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun PieceProgress(piece: Piece) {
    val progress = when (piece.status) {
        LearningStatus.PLANNED -> 0f
        LearningStatus.LEARNING -> .33f
        LearningStatus.POLISHING -> .67f
        LearningStatus.READY -> 1f
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Learning stage · ${piece.status.label}", color = Gold, style = MaterialTheme.typography.labelMedium)
        LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(3.dp), color = Gold, trackColor = Gold.copy(alpha = .12f))
    }
}

@Composable private fun WeeklyActivity(sessions: List<PracticeSession>) {
    val today = LocalDate.now()
    val days = (6 downTo 0).map { today.minusDays(it.toLong()) }
    val totals = days.map { day -> sessions.filter { dayOf(it.completedAt) == day }.sumOf { it.durationMillis } }
    val peak = totals.maxOrNull()?.coerceAtLeast(60000L) ?: 60000L
    Panel {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("The past seven days", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            Text("${totals.sum() / 60000} min", color = Gold)
        }
        Text("Every return to the piano counts.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            days.forEachIndexed { index, day ->
                Column(Modifier.weight(1f).semantics(mergeDescendants = true) {
                    contentDescription = "${day.format(DateTimeFormatter.ofPattern("EEEE, d MMMM"))}: ${totals[index] / 60000} minutes"
                }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.fillMaxWidth().height(88.dp), contentAlignment = Alignment.BottomCenter) {
                        Box(Modifier.widthIn(max = 30.dp).fillMaxWidth().height(88.dp).background(Gold.copy(alpha = .04f), RoundedCornerShape(8.dp)))
                        Box(Modifier.widthIn(max = 30.dp).fillMaxWidth().height((4 + 84 * totals[index].toFloat() / peak).dp)
                            .background(Brush.verticalGradient(listOf(Gold, Gold.copy(alpha = .4f))), RoundedCornerShape(8.dp)))
                    }
                    Text(day.format(DateTimeFormatter.ofPattern("EEEEE")), color = if (day == today) Gold else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        if (totals.all { it == 0L }) Text("No practice recorded this week yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun PracticeDial(timer: TimerState, motion: Boolean) {
    // Each revolution represents one minute; the session remains open ended.
    val target = (timer.elapsed % 60000) / 60000f
    val progress by animateFloatAsState(target, tween(if (motion && target > .01f) 200 else 0), label = "Practice minute")
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        val diameter = minOf(maxWidth, 300.dp)
        Box(Modifier.size(diameter).semantics(mergeDescendants = true) {
            contentDescription = "Practice time ${duration(timer.elapsed)}. ${if (timer.running) "Running" else "Paused"}"
        }, contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize().padding(8.dp)) {
                drawCircle(Gold.copy(alpha = .025f))
                drawCircle(Gold.copy(alpha = .12f), style = Stroke(2.dp.toPx()))
                drawArc(Gold, -90f, progress * 360f, false, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.Piano, null, tint = Gold, modifier = Modifier.size(28.dp))
                Text(duration(timer.elapsed), fontFamily = FontFamily.Serif, fontSize = if (diameter < 260.dp) 32.sp else 42.sp, color = Ivory, maxLines = 1)
                Text(if (timer.running) "IN THE MOMENT" else if (timer.elapsed > 0) "TAKE A BREATH" else "YOUR TIME, YOUR TEMPO", style = MaterialTheme.typography.labelSmall, color = Gold, fontSize = 9.sp)
            }
        }
    }
    Text("One revolution · one minute", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
