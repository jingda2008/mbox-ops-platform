package com.mbox.staff

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class MenuDestination(val session: String, val tableCode: String)

@Composable
fun MenuFilters(
    query: String,
    onQuery: (String) -> Unit,
    category: String,
    onCategory: (String) -> Unit,
    categories: List<Pair<String, String>>,
) {
    OutlinedTextField(
        query,
        onQuery,
        label = { Text("搜索菜品、套餐或编码") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        (listOf("" to "全部菜单") + categories).forEach { (id, name) ->
            FilterChip(
                selected = category == id,
                onClick = { onCategory(id) },
                label = { Text(name) },
                colors =
                    FilterChipDefaults.filterChipColors(
                        selectedContainerColor = Ink,
                        selectedLabelColor = Paper,
                    ),
            )
        }
    }
}

@Composable
fun MenuThumbnail(url: String? = null) {
    val bitmap by
        produceState<ImageBitmap?>(null, url) {
            value = null
            if (url != null)
                value =
                    withContext(Dispatchers.IO) {
                        runCatching {
                                // Public immutable media only; this connection carries no employee
                                // session cookies.
                                val connection = URL(url).openConnection() as HttpURLConnection
                                try {
                                    connection.connectTimeout = 5000
                                    connection.readTimeout = 5000
                                    connection.instanceFollowRedirects = false
                                    if (connection.responseCode != 200) return@runCatching null
                                    val bytes =
                                        connection.inputStream.use { input ->
                                            val output = java.io.ByteArrayOutputStream()
                                            val buffer = ByteArray(8192)
                                            while (output.size() <= 2 * 1024 * 1024) {
                                                val count = input.read(buffer)
                                                if (count < 0) break
                                                output.write(buffer, 0, count)
                                            }
                                            output.toByteArray()
                                        }
                                    if (bytes.size > 2 * 1024 * 1024) return@runCatching null
                                    val bounds =
                                        BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                                    if (bounds.outWidth !in 1..8192 || bounds.outHeight !in 1..8192)
                                        return@runCatching null
                                    val options =
                                        BitmapFactory.Options().apply {
                                            inSampleSize =
                                                maxOf(
                                                    1,
                                                    maxOf(bounds.outWidth, bounds.outHeight) / 240,
                                                )
                                        }
                                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                                        ?.asImageBitmap()
                                } finally {
                                    connection.disconnect()
                                }
                            }
                            .getOrNull()
                    }
        }
    Box(
        Modifier.size(76.dp).clip(RoundedCornerShape(12.dp)).background(Gold.copy(alpha = .14f)),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null)
            Image(bitmap!!, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Icon(Icons.Outlined.Restaurant, null, tint = Ink.copy(alpha = .6f))
    }
}
