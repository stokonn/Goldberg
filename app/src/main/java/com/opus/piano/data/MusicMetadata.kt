package com.opus.piano.data

/** Catalogue IDs take precedence; manual works are linked only by an exact full composer name. */
object ComposerIdentity {
    const val BACH = "87"
    const val CHOPIN = "152"
    const val MOZART = "196"
    private val canonicalNames = mapOf(
        "johann sebastian bach" to BACH,
        "frederic chopin" to CHOPIN,
        "frederic francois chopin" to CHOPIN,
        "wolfgang amadeus mozart" to MOZART
    )
    fun resolve(piece: Piece, works: Map<String, CatalogWork>): String? =
        piece.catalogWorkId?.let { works[it]?.composerId } ?: canonicalNames[catalogText(piece.composer)]
}

fun mastered(piece: Piece): Boolean = piece.status == LearningStatus.READY
fun pianoComposition(piece: Piece, work: CatalogWork?): Boolean =
    Regex("\\b(piano|pianoforte)\\b", RegexOption.IGNORE_CASE).containsMatchIn("${piece.instrument} ${piece.title} ${work?.title.orEmpty()} ${work?.subtitle.orEmpty()}")

fun pieceWork(piece: Piece, catalog: CatalogSnapshot): CatalogWork? = catalog.works.firstOrNull { it.id == piece.catalogWorkId }
fun pieceEra(piece: Piece, catalog: CatalogSnapshot): String = piece.musicalEra.ifBlank {
    val composerId = ComposerIdentity.resolve(piece, catalog.works.associateBy { it.id })
    catalog.composers.firstOrNull { it.id == composerId }?.epoch.orEmpty()
}
fun pieceGenre(piece: Piece, catalog: CatalogSnapshot): String = piece.genre.ifBlank { pieceWork(piece, catalog)?.genre.orEmpty() }
fun pieceComposerMatches(piece: Piece, composer: CatalogComposer, catalog: CatalogSnapshot): Boolean =
    ComposerIdentity.resolve(piece, catalog.works.associateBy { it.id }) == composer.id ||
        (piece.catalogWorkId == null && catalogText(piece.composer) == catalogText(composer.name))
fun sessionComposerId(session: PracticeSession, pieces: List<Piece>, catalog: CatalogSnapshot): String? = session.composerId
    ?: session.catalogWorkId?.let { id -> catalog.works.firstOrNull { it.id == id }?.composerId }
    ?: pieces.firstOrNull { it.id == session.pieceId }?.let { ComposerIdentity.resolve(it, catalog.works.associateBy { w -> w.id }) }

fun learningProgress(status: LearningStatus): Float = when (status) {
    LearningStatus.PLANNED -> 0f
    LearningStatus.LEARNING -> .33f
    LearningStatus.POLISHING -> .67f
    LearningStatus.READY -> 1f
}
