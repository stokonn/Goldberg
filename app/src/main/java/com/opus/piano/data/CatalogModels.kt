package com.opus.piano.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow
import java.text.Normalizer
import java.util.Locale

/** The same normalization is used for server queries and offline suggestions. */
fun catalogText(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD)
    .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)
    .replace("ø", "o").replace("ł", "l").replace("ß", "ss").replace("æ", "ae").replace("œ", "oe")
    .replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim().replace(Regex("\\s+"), " ")

@Entity(tableName = "catalog_composers")
data class CatalogComposer(
    @PrimaryKey val id: String,
    val name: String,
    val birth: String = "",
    val death: String = "",
    val epoch: String = ""
) {
    // Open Opus dates frequently use January 1 as a year placeholder. Never present those as exact dates.
    val years: String get() = listOf(birth.take(4).ifBlank { "?" }, death.take(4).ifBlank { "…" }).joinToString(" – ")
}

@Entity(tableName = "catalog_works", indices = [Index("composerId")])
data class CatalogWork(
    @PrimaryKey val id: String,
    val composerId: String,
    val title: String,
    val subtitle: String = "",
    val genre: String = "",
    val searchTerms: String = "",
    val catalogue: String = "",
    val catalogueNumber: String = "",
    val musicalKey: String = "",
    @ColumnInfo(defaultValue = "0") val popular: Boolean = false,
    @ColumnInfo(defaultValue = "0") val recommended: Boolean = false
) {
    val keyFromTitle: String get() = Regex("\\bin ([A-G](?: flat| sharp)? (?:major|minor))\\b").find(title)?.groupValues?.get(1).orEmpty()
    val catalogLabel: String get() = listOf(catalogue, catalogueNumber).filter { it.isNotBlank() }.joinToString(" ")
}

@Entity(tableName = "catalog_cache")
data class CatalogCache(@PrimaryKey val cacheKey: String, val payload: String, val fetchedAt: Long)

data class CatalogSnapshot(val composers: List<CatalogComposer>, val works: List<CatalogWork>)

data class Portrait(val url: String, val artist: String, val credit: String, val license: String, val licenseUrl: String, val sourceUrl: String)
data class ComposerProfile(
    val text: String = "", val articleUrl: String = "", val wikidataUrl: String = "",
    val birth: String = "", val death: String = "", val portrait: Portrait? = null,
    val license: String = "", val licenseUrl: String = "", val origin: String = ""
)
data class CatalogLoad<T>(val value: T, val cached: Boolean, val warning: String? = null, val fetchedAt: Long = 0L)

@Dao
interface CatalogDao {
    @Query("SELECT * FROM catalog_composers ORDER BY name COLLATE NOCASE") fun composers(): Flow<List<CatalogComposer>>
    @Query("SELECT * FROM catalog_works ORDER BY title COLLATE NOCASE") fun works(): Flow<List<CatalogWork>>
    @Query("SELECT * FROM catalog_composers") suspend fun allComposers(): List<CatalogComposer>
    @Query("SELECT * FROM catalog_works") suspend fun allWorks(): List<CatalogWork>
    @Query("SELECT * FROM catalog_composers WHERE id = :id") suspend fun composer(id: String): CatalogComposer?
    @Query("SELECT * FROM catalog_works WHERE id = :id") suspend fun work(id: String): CatalogWork?
    @Upsert suspend fun putComposers(items: List<CatalogComposer>)
    @Upsert suspend fun putWorks(items: List<CatalogWork>)
    @Query("SELECT * FROM catalog_cache WHERE cacheKey = :key") suspend fun cache(key: String): CatalogCache?
    @Upsert suspend fun putCache(value: CatalogCache)
}
