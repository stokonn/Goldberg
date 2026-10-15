package com.opus.piano.data

import java.time.LocalDate
import java.time.ZoneId

/** Receives the period-filtered sessions. Include both partial boundary months of a trailing year. */
fun activityBins(sessions: List<PracticeSession>, period: String, today: LocalDate, zone: ZoneId): List<Pair<String, Long>> {
    val days = sessions.groupBy { AchievementEngine.recordedDay(it, zone) }.mapValues { (_, values) -> values.sumOf { it.durationMillis } }
    return when (period) {
        "Week" -> (6 downTo 0).map { today.minusDays(it.toLong()).let { d -> d.dayOfWeek.name.take(2) to (days[d] ?: 0L) } }
        "Month" -> (5 downTo 0).map { offset -> val end = today.minusDays(offset * 5L); "${end.dayOfMonth}" to days.filterKeys { it > end.minusDays(5) && it <= end }.values.sum() }
        else -> {
            val months = if (period == "Year") 13 else ((days.keys.minOrNull()?.let { java.time.temporal.ChronoUnit.MONTHS.between(java.time.YearMonth.from(it), java.time.YearMonth.from(today)).toInt() } ?: 0) + 1).coerceAtLeast(1)
            val group = if (period == "Year") 1 else ((months + 11) / 12).coerceAtLeast(1)
            ((months + group - 1) / group - 1 downTo 0).map { offset -> val end = java.time.YearMonth.from(today).minusMonths(offset * group.toLong()); end.toString() to days.filterKeys { java.time.YearMonth.from(it) <= end && java.time.YearMonth.from(it) > end.minusMonths(group.toLong()) }.values.sum() }
        }
    }
}
