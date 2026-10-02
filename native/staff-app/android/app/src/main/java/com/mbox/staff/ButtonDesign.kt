package com.mbox.staff

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun Primary(text: String, enabled: Boolean = true, icon: ImageVector? = null, action: () -> Unit) {
    val symbol =
        icon
            ?: when {
                text.startsWith("提交") -> Icons.Outlined.CheckCircle
                text.contains("开台") -> Icons.Outlined.People
                text.contains("现金") -> Icons.Outlined.Payments
                text.contains("登录") -> Icons.Outlined.LockOpen
                else -> Icons.Outlined.AddCircleOutline
            }
    ActionSurface(enabled = enabled, primary = true, onClick = action) {
        Icon(symbol, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(9.dp))
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun PrimaryAction(onClick: () -> Unit, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    ActionSurface(enabled=enabled,primary=true,onClick=onClick,content=content)
}

@Composable
fun SecondaryAction(
    onClick: () -> Unit,
    enabled: Boolean = true,
    danger: Boolean = false,
    icon: ImageVector? = null,
    content: @Composable RowScope.() -> Unit,
) {
    ActionSurface(enabled = enabled, danger = danger, onClick = onClick) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(19.dp))
            Spacer(Modifier.width(9.dp))
        }
        content()
    }
}

@Composable
private fun ActionSurface(
    enabled: Boolean,
    primary: Boolean = false,
    danger: Boolean = false,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by
        animateFloatAsState(
            if (enabled && pressed) .985f else 1f,
            tween(140),
            label = "buttonPress",
        )
    val elevation = if (!enabled || pressed) 0.dp else if (primary) 4.dp else 2.dp
    val shape = RoundedCornerShape(14.dp)
    val foreground = if (primary) Color.White else if (danger) Color(0xFF963E38) else Ink
    val colors =
        when {
            !enabled -> listOf(Color(0xFFE8E9E3), Color(0xFFE1E3DC))
            primary -> listOf(Color(0xFF2D4C3B), Ink, Color(0xFF12251C))
            danger -> listOf(Color(0xFFFFFCFA), Color(0xFFF8EEEA))
            else -> listOf(Color.White, Color(0xFFEEF2EB))
        }
    Button(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        modifier =
            Modifier.fillMaxWidth()
                .heightIn(min = if (primary) 50.dp else 48.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationY = if (enabled && pressed) 1.dp.toPx() else 0f
                }
                .shadow(elevation, shape, ambientColor = Ink, spotColor = Ink)
                .background(Brush.verticalGradient(colors), shape),
        shape = shape,
        elevation = ButtonDefaults.buttonElevation(0.dp, 0.dp),
        border =
            BorderStroke(
                1.dp,
                Brush.verticalGradient(
                    if (enabled && primary)
                        listOf(Gold.copy(alpha = .55f), Color.White.copy(alpha = .06f))
                    else listOf(Color.White, foreground.copy(alpha = .18f))
                ),
            ),
        colors =
            ButtonDefaults.buttonColors(
                containerColor = Color.Transparent,
                contentColor = foreground,
                disabledContainerColor = Color.Transparent,
                disabledContentColor = Color(0xFF858C84),
            ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        content = content,
    )
}

@Composable
fun TactileIconButton(
    onClick: () -> Unit,
    enabled: Boolean = true,
    prominent: Boolean = false,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by
        animateFloatAsState(if (enabled && pressed) .94f else 1f, tween(120), label = "roundPress")
    FilledIconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        modifier =
            Modifier.size(48.dp).graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
        shape = CircleShape,
        colors =
            IconButtonDefaults.filledIconButtonColors(
                containerColor = if (prominent) Ink else Color(0xFFEDF1E9),
                contentColor = if (prominent) Color.White else Ink,
                disabledContainerColor = Color(0xFFE7E9E2),
                disabledContentColor = Color(0xFF92988F),
            ),
    ) {
        Box(Modifier.shadow(if (enabled && !pressed) 1.dp else 0.dp, CircleShape)) { content() }
    }
}
