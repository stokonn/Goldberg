package com.opus.piano

import com.opus.piano.data.*
import org.junit.Assert.*
import org.junit.Test
import java.net.URI
import java.net.URLDecoder

class RecordingLinksTest {
    @Test fun recordingUrlsRecognizeSupportedPlatforms() {
        assertEquals(StudyService.SPOTIFY, RecordingLinks.validate("https://open.spotify.com/track/fixture123?si=123")?.platform)
        assertEquals(StudyService.SPOTIFY, RecordingLinks.validate("https://open.spotify.com/intl-de/album/fixture123")?.platform)
        assertEquals(StudyService.YOUTUBE, RecordingLinks.validate("https://youtu.be/abcdefghijk?t=20")?.platform)
        assertEquals(StudyService.YOUTUBE, RecordingLinks.validate("https://www.youtube.com/watch?v=abcdefghijk")?.platform)
        assertEquals(StudyService.YOUTUBE, RecordingLinks.validate("https://music.youtube.com/watch?v=abcdefghijk")?.platform)
        assertEquals(StudyService.IMSLP, RecordingLinks.validate("https://imslp.org/wiki/Fixture_score")?.platform)
        assertEquals(StudyService.MUSESCORE, RecordingLinks.validate("https://musescore.com/user/123/scores/456")?.platform)
        assertEquals(StudyService.MUSESCORE, RecordingLinks.validate("https://musescore.com/fixture/scores/456")?.platform)
    }
    @Test fun unsafeInvalidAndLookalikeUrlsAreRejected() {
        listOf("", "not a url", "javascript:alert(1)", "file:///tmp/score", "http://youtu.be/abcdefghijk", "https://youtube.com.evil.example/watch?v=abcdefghijk", "https://youtube.com@evil.example/watch?v=abcdefghijk", "https://user:password@www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com:444/watch?v=abcdefghijk", "https://youtu.be/short", "https://www.youtube.com/watch", "https://open.spotify.com/search/Chopin", "https://imslp.org/wiki/Special:Search", "https://musescore.com/sheetmusic?text=fixture", "https://www.youtube.com/watch?v=%xx").forEach { assertNull(it, RecordingLinks.validate(it)) }
    }
    @Test fun searchesEncodeAccentsPunctuationAndMovementWithoutGeneratingFakeRecordings() {
        val composer = "Frédéric Chopin"
        val title = "Nocturne & étude"
        val terms = RecordingLinks.searchTerms(composer, title, "Op. 9", "II. Andante")
        StudyService.entries.forEach { service ->
            val url = RecordingLinks.search(service, composer, title, "Op. 9", "II. Andante")
            val uri = URI(url)
            assertEquals("https", uri.scheme)
            val raw = when (service) {
                StudyService.SPOTIFY -> uri.rawPath.substringAfter("/search/")
                else -> uri.rawQuery.split('&').first { it.startsWith(if (service == StudyService.YOUTUBE) "search_query=" else if (service == StudyService.IMSLP) "search=" else "text=") }.substringAfter('=')
            }
            assertEquals(terms, URLDecoder.decode(raw, "UTF-8"))
            assertNull("A generated search is not a saved recording URL", RecordingLinks.validate(url))
        }
    }
    @Test fun catalogueNumberIsNotDuplicatedWhenItIsAlreadyInTheTitle() {
        assertEquals("Composer Sonata, op. 17", RecordingLinks.searchTerms("Composer", "Sonata, op. 17", "op 17"))
    }
}
