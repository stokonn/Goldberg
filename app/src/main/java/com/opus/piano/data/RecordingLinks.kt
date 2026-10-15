package com.opus.piano.data

import java.net.URI
import java.net.URLEncoder
import java.net.URLDecoder
import java.util.Locale

enum class StudyService(val label: String) { SPOTIFY("Spotify"), YOUTUBE("YouTube"), IMSLP("IMSLP"), MUSESCORE("MuseScore") }
data class ValidRecordingUrl(val url: String, val platform: StudyService)

object RecordingLinks {
    fun searchTerms(composer: String, title: String, catalogue: String = "", movement: String = ""): String =
        listOf(composer.trim(), title.trim(), catalogue.trim().takeUnless { it.isNotBlank() && catalogText(title).contains(catalogText(it)) }.orEmpty(), movement.trim())
            .filter { it.isNotBlank() }.joinToString(" ").replace(Regex("\\s+"), " ")
    fun search(service: StudyService, composer: String, title: String, catalogue: String = "", movement: String = ""): String {
        val terms = searchTerms(composer, title, catalogue, movement)
        val query = URLEncoder.encode(terms, "UTF-8").replace("+", "%20")
        return when (service) {
            StudyService.SPOTIFY -> "https://open.spotify.com/search/$query"
            StudyService.YOUTUBE -> "https://www.youtube.com/results?search_query=$query"
            StudyService.IMSLP -> "https://imslp.org/index.php?title=Special%3ASearch&search=$query"
            StudyService.MUSESCORE -> "https://musescore.com/sheetmusic?text=$query"
        }
    }
    fun validate(input: String): ValidRecordingUrl? = try {
        val text = input.trim()
        val uri = URI(text)
        val host = uri.host?.lowercase(Locale.ROOT).orEmpty()
        val path = uri.path.orEmpty()
        val query = uri.rawQuery.orEmpty().split('&').mapNotNull { item ->
            val pair = item.split('=', limit = 2)
            if (pair.size == 2) URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair[1], "UTF-8") else null
        }.toMap()
        val platform = when {
            uri.scheme != "https" || uri.userInfo != null || (uri.port != -1 && uri.port != 443) || text.length > 4096 -> null
            host == "open.spotify.com" && path.matches(Regex("/(?:intl-[a-zA-Z-]+/)?(?:track|album)/[A-Za-z0-9]+/?")) -> StudyService.SPOTIFY
            host in setOf("youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com") &&
                ((path == "/watch" && query["v"]?.matches(Regex("[A-Za-z0-9_-]{11}")) == true) || path.matches(Regex("/(?:shorts|live)/[A-Za-z0-9_-]{11}/?")) || (path == "/playlist" && query["list"]?.matches(Regex("[A-Za-z0-9_-]{10,}")) == true)) -> StudyService.YOUTUBE
            host == "youtu.be" && path.matches(Regex("/[A-Za-z0-9_-]{11}/?")) -> StudyService.YOUTUBE
            host in setOf("imslp.org", "www.imslp.org") && path.startsWith("/wiki/") && path.length > 6 && !path.substringAfter("/wiki/").contains(':') -> StudyService.IMSLP
            host in setOf("musescore.com", "www.musescore.com") && path.matches(Regex("/[^/]+(?:/[^/]+)?/scores/[0-9]+/?")) -> StudyService.MUSESCORE
            else -> null
        }
        platform?.let { ValidRecordingUrl(uri.toASCIIString(), it) }
    } catch (_: Exception) { null }
}
