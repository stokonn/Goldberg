package com.opus.piano.ui

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp

val Gold = Color(0xFFD4AF73)
val Ivory = Color(0xFFF5F0E8)
private val Palette = darkColorScheme(
    primary = Gold, onPrimary = Color(0xFF241D13), primaryContainer = Color(0xFF342C24), onPrimaryContainer = Ivory,
    background = Color(0xFF101014), onBackground = Ivory,
    surface = Color(0xFF1B1B21), onSurface = Ivory,
    surfaceVariant = Color(0xFF27272F), onSurfaceVariant = Color(0xFFA6A1A8),
    outline = Color(0xFF77717B), secondary = Color(0xFFD4AF73), error = Color(0xFFFFB4AB)
)
@Composable fun OpusTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Palette, typography = Typography(
        headlineLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 36.sp, lineHeight = 42.sp),
        headlineMedium = TextStyle(fontFamily = FontFamily.Serif, fontSize = 28.sp, lineHeight = 34.sp),
        titleLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 23.sp, lineHeight = 29.sp),
        labelSmall = TextStyle(fontSize = 11.sp, letterSpacing = 1.5.sp, fontWeight = FontWeight.Medium)
    ), shapes = Shapes(
        small = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        medium = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
        large = androidx.compose.foundation.shape.RoundedCornerShape(28.dp)
    ), content = content)
}
