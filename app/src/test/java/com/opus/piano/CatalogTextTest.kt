package com.opus.piano

import com.opus.piano.data.CatalogWork
import com.opus.piano.data.catalogText
import org.junit.Assert.*
import org.junit.Test

class CatalogTextTest {
    @Test fun accentedNamesAndCombiningCharactersMatch() {
        assertEquals(catalogText("Antonín Dvořák"), catalogText("ANTONIN DVORAK"))
        assertEquals(catalogText("Frédéric"), catalogText("Fre\u0301de\u0301ric"))
        assertEquals("lodz o ss ae oe", catalogText("Łódź Ø ß Æ Œ"))
    }
    @Test fun catalogueNumbersAndWhitespaceNormalizeConsistently() {
        assertEquals("op 17", catalogText("  Op.  17 "))
        assertEquals("k 331", catalogText("K.331"))
        assertEquals("", catalogText("   "))
    }
    @Test fun keyMustBeExplicitlyStatedNotGuessedFromNumbers() {
        assertEquals("E flat major", CatalogWork("1", "2", "Fixture in E flat major, op. 2").keyFromTitle)
        assertEquals("", CatalogWork("1", "2", "Fixture no. 4, op. 2").keyFromTitle)
        assertEquals("", CatalogWork("1", "2", "Fixture in C").keyFromTitle)
    }
}
