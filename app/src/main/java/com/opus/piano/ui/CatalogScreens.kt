package com.opus.piano.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.opus.piano.data.*
import kotlinx.coroutines.CancellationException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable private fun CatalogBack(label: String, back: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = Gold)
    }
}
@Composable private fun CatalogFeedback(message: String, retry: () -> Unit) {
    Panel {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.CloudOff, null, tint = Gold)
            Text(message, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        }
        TextButton(onClick = retry) { Text("Try again") }
    }
}
@Composable private fun SourceLink(label: String, url: String) {
    val uri = LocalUriHandler.current
    if (url.startsWith("https://")) TextButton(onClick = { try { uri.openUri(url) } catch (_: IllegalArgumentException) { } catch (_: android.content.ActivityNotFoundException) { } }) {
        Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Text(label)
    }
}
@Composable private fun CacheCaption(at: Long) {
    if (at > 0) Text("Saved on device · ${Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM yyyy"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
private fun alreadyAdded(work: CatalogWork, composer: CatalogComposer?, pieces: List<Piece>): Boolean = pieces.any {
    it.catalogWorkId == work.id || (it.catalogWorkId == null && catalogText(it.title) == catalogText(work.title) && catalogText(it.composer) == catalogText(composer?.name.orEmpty()))
}

@Composable fun CatalogScreen(model: CatalogViewModel, library: LibraryState, back: () -> Unit, composerPage: (String) -> Unit, workPage: (String) -> Unit) {
    val state by model.browse.collectAsStateWithLifecycle()
    val results by model.results.collectAsStateWithLifecycle()
    val snapshot by model.snapshot.collectAsStateWithLifecycle()
    val adding by model.adding.collectAsStateWithLifecycle()
    val composers = remember(snapshot.composers) { snapshot.composers.associateBy { it.id } }
    var limit by rememberSaveable(state.activeQuery) { mutableIntStateOf(40) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { CatalogBack("Your musical discoveries", back) }
        item { Heading("OPEN OPUS COLLECTION", "A world of music.", "Discover composers and works. Make the next piece part of your story.") }
        item {
            OutlinedTextField(state.query, model::query, Modifier.fillMaxWidth(), label = { Text("Search works or composers") },
                placeholder = { Text("Title, composer or catalogue number") }, leadingIcon = { Icon(Icons.Outlined.Search, null) },
                trailingIcon = { if (state.query.isNotEmpty()) IconButton(onClick = { model.query("") }) { Icon(Icons.Outlined.Close, "Clear search") } }, singleLine = true)
        }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        state.error?.let { message -> item { CatalogFeedback(message, model::refreshSearch) } }
        state.warning?.let { message -> item { CatalogFeedback(message, model::refreshSearch) } }
        item {
            Text(if (state.query.isBlank()) "COMPOSERS IN YOUR SAVED CATALOGUE" else "SUGGESTIONS · SAVED & NEW DISCOVERIES", style = MaterialTheme.typography.labelSmall, color = Gold)
            Spacer(Modifier.height(6.dp))
            Text("Search ignores accents. Offline results include previously loaded information; connect to discover more. Catalogue titles are supplied by Open Opus in their original language.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (results.composers.isNotEmpty()) {
            item { SectionTitle("Composers") }
            items(results.composers.take(limit), key = { "composer:${it.id}" }) { composer ->
                Surface(onClick = { composerPage(composer.id) }, shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, Gold.copy(alpha = .1f))) {
                    Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Icon(Icons.Outlined.PersonOutline, null, tint = Gold)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(composer.name, style = MaterialTheme.typography.titleLarge)
                            Text("${composer.years} · ${composer.epoch}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Icon(Icons.Outlined.ChevronRight, null, tint = Gold)
                    }
                }
            }
        }
        if (results.works.isNotEmpty()) item { SectionTitle("Works") }
        items(results.works.take(limit), key = { "work:${it.id}" }) { work ->
            WorkCard(work, composers[work.composerId], alreadyAdded(work, composers[work.composerId], library.pieces), work.id in adding,
                { workPage(work.id) }, { composers[work.composerId]?.let { model.add(work, it) } })
        }
        if (!state.loading && results.composers.isEmpty() && results.works.isEmpty()) item {
            Panel {
                Icon(Icons.Outlined.LibraryMusic, null, tint = Gold)
                SectionTitle(if (state.error != null) "Your discoveries will live here" else "No matching music")
                Text(if (state.error != null) "An internet connection is needed for your first catalogue discovery." else "Try a different title, composer, or catalogue number. A title may refer to several different works.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (results.works.size > limit || results.composers.size > limit) item { OutlinedButton(onClick = { limit += 40 }) { Text("More saved suggestions") } }
        if (state.next != null) item { Button(onClick = model::nextPage, enabled = !state.loading) { Text("Discover more results") } }
        item { CacheCaption(state.fetchedAt); SourceLink("Catalogue: Open Opus · public domain", "https://openopus.org/") }
    }
}

@Composable private fun WorkCard(work: CatalogWork, composer: CatalogComposer?, added: Boolean, adding: Boolean, open: () -> Unit, add: () -> Unit) {
    Surface(onClick = open, shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, Gold.copy(alpha = .1f))) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(work.title, style = MaterialTheme.typography.titleLarge)
                    Text(composer?.name ?: "Composer unavailable", color = Gold, style = MaterialTheme.typography.bodyMedium)
                }
                IconButton(onClick = add, enabled = !added && !adding && composer != null) {
                    if (adding) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    else Icon(if (added) Icons.Outlined.Check else Icons.Outlined.Add, if (added) "Already in repertoire" else "Add ${work.title} to repertoire", tint = if (added) MaterialTheme.colorScheme.onSurfaceVariant else Gold)
                }
            }
            if (work.subtitle.isNotBlank()) Text(work.subtitle, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("${work.genre.ifBlank { "Work" }} · Open Opus #${work.id}${if (added) " · In repertoire" else ""}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable fun ComposerScreen(id: String, model: CatalogViewModel, library: LibraryState, back: () -> Unit, workPage: (String) -> Unit) {
    val snapshot by model.snapshot.collectAsStateWithLifecycle()
    val page by model.composer.collectAsStateWithLifecycle()
    val adding by model.adding.collectAsStateWithLifecycle()
    val composer = snapshot.composers.firstOrNull { it.id == id }
    val works = remember(snapshot.works, id) { snapshot.works.filter { it.composerId == id } }
    var query by rememberSaveable(id) { mutableStateOf("") }
    val matches = remember(works, query) { works.filter { catalogText("${it.title} ${it.subtitle} ${it.catalogLabel}").contains(catalogText(query)) } }
    LaunchedEffect(id) { model.loadComposer(id) }
    val profile = page.takeIf { it.id == id }?.profile
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { CatalogBack("Composer portrait", back) }
        if (composer == null) {
            item { CatalogFeedback("This composer is not saved on this device.") { model.loadComposer(id, true) } }
        } else {
            item { Heading(composer.epoch.ifBlank { "Composer" }, composer.name, composer.years) }
            item { ComposerPortrait(profile?.portrait, model.repository, composer.name) }
            item {
                Panel {
                    SectionTitle("A life in music")
                    if (page.profileLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (!profile?.birth.isNullOrBlank()) Text("Born · ${profile?.birth}", color = Gold)
                    if (!profile?.death.isNullOrBlank()) Text("Died · ${profile?.death}", color = Gold)
                    Text(profile?.text?.ifBlank { null } ?: if (page.profileLoading) "Loading a sourced biography…" else "No verified biography is available for this composer.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (profile != null) {
                        SourceLink("Wikipedia · contributors", profile.articleUrl)
                        SourceLink("Article history & authors", if (profile.articleUrl.isBlank()) "" else "${profile.articleUrl}?action=history")
                        SourceLink(profile.license, profile.licenseUrl)
                        SourceLink("Identity & life dates: Wikidata · CC0", profile.wikidataUrl)
                        if (profile.text.isNotBlank()) Text("English Wikipedia excerpt, unchanged.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            page.profileError?.let { message -> item { CatalogFeedback(message) { model.loadComposer(id, true) } } }
            item {
                Text("WORKS · ${works.size}", style = MaterialTheme.typography.labelSmall, color = Gold, modifier = Modifier.semantics { heading() })
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Filter this composer’s works") }, leadingIcon = { Icon(Icons.Outlined.Search, null) })
            }
            if (page.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            page.error?.let { message -> item { CatalogFeedback(message) { model.loadComposer(id, true) } } }
            page.warning?.let { message -> item { CatalogFeedback(message) { model.loadComposer(id, true) } } }
            if (!page.loading && matches.isEmpty()) item { Panel { Text("No works available for this selection.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            items(matches, key = { it.id }) { work -> WorkCard(work, composer, alreadyAdded(work, composer, library.pieces), work.id in adding, { workPage(work.id) }, { model.add(work, composer) }) }
            item { CacheCaption(page.fetchedAt); SourceLink("Works & period: Open Opus · public domain", "https://openopus.org/"); TextButton(onClick = { model.loadComposer(id, true) }) { Text("Refresh composer") } }
        }
    }
}

@Composable private fun ComposerPortrait(portrait: Portrait?, repository: CatalogRepository, name: String) {
    var retry by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    val bitmap by produceState<android.graphics.Bitmap?>(null, portrait?.url, retry) {
        loading = portrait != null
        value = null
        if (portrait != null) {
            try { value = repository.portrait(portrait.url) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { value = null }
            finally { loading = false }
        }
    }
    Panel {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (bitmap != null) Image(bitmap!!.asImageBitmap(), "Portrait of $name", Modifier.size(180.dp).clip(RoundedCornerShape(24.dp)), contentScale = ContentScale.Crop)
            else Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.PersonOutline, null, tint = Gold, modifier = Modifier.size(64.dp))
                Text("Portrait unavailable or not yet loaded", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (portrait != null && bitmap == null && !loading) TextButton(onClick = { retry++ }) { Text("Retry portrait") }
        if (portrait != null) {
            Text(portrait.artist, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (portrait.credit.isNotBlank()) Text(portrait.credit, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SourceLink("Image source · Wikimedia Commons", portrait.sourceUrl)
            if (portrait.licenseUrl.isNotBlank()) SourceLink(portrait.license, portrait.licenseUrl)
            else Text(portrait.license, style = MaterialTheme.typography.bodySmall, color = Gold)
            Text("Displayed as a square crop.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable fun WorkScreen(id: String, model: CatalogViewModel, library: LibraryState, back: () -> Unit, composerPage: (String) -> Unit) {
    val snapshot by model.snapshot.collectAsStateWithLifecycle()
    val page by model.work.collectAsStateWithLifecycle()
    val adding by model.adding.collectAsStateWithLifecycle()
    val work = snapshot.works.firstOrNull { it.id == id }
    val composer = snapshot.composers.firstOrNull { it.id == work?.composerId }
    LaunchedEffect(id) { model.loadWork(id) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item { CatalogBack("Work detail", back) }
        if (page.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        page.error?.let { message -> item { CatalogFeedback(message) { model.loadWork(id, true) } } }
        page.warning?.let { message -> item { CatalogFeedback(message) { model.loadWork(id, true) } } }
        if (work != null) {
            item { Heading(work.genre.ifBlank { "Composition" }, work.title, composer?.name ?: "Composer unavailable") }
            item {
                Panel {
                    if (work.subtitle.isNotBlank()) Text(work.subtitle, style = MaterialTheme.typography.titleLarge)
                    DetailField("Composer", composer?.name.orEmpty())
                    if (composer != null) TextButton(onClick = { composerPage(composer.id) }) { Text("Explore the composer") }
                    HorizontalDivider(color = Gold.copy(alpha = .12f))
                    DetailField("Catalogue number", work.catalogLabel)
                    DetailField(if (work.musicalKey.isBlank() && work.keyFromTitle.isNotBlank()) "Key · stated in the title" else "Key", work.musicalKey.ifBlank { work.keyFromTitle })
                    DetailField("Genre", work.genre)
                    Text("Open Opus work #${work.id} · composer #${work.composerId}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("Some works share a title. Check the composer, catalogue number and source ID before adding.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item {
                val added = alreadyAdded(work, composer, library.pieces)
                Button(onClick = { composer?.let { model.add(work, it) } }, enabled = !added && id !in adding && composer != null, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Icon(if (added) Icons.Outlined.Check else Icons.Outlined.Add, null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (added) "In your repertoire" else if (id in adding) "Adding…" else "Add to repertoire")
                }
            }
        } else if (!page.loading) item { Panel { SectionTitle("Work unavailable"); Text("No saved detail is available. Connect and try again.", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        item { CacheCaption(page.fetchedAt); SourceLink("Source: Open Opus · public domain", "https://api.openopus.org/work/detail/$id.json"); TextButton(onClick = { model.loadWork(id, true) }) { Text("Refresh detail") } }
    }
}
@Composable private fun DetailField(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = Gold)
        Text(value.ifBlank { "Not provided by the source" }, color = if (value.isBlank()) MaterialTheme.colorScheme.onSurfaceVariant else Ivory)
    }
}
