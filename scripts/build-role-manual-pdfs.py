#!/usr/bin/env python3
"""Build combined and per-employee M-BOX role manual PDFs."""

from __future__ import annotations

import html
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.fonts import addMapping
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
MANUAL_DIR = ROOT / "docs" / "role-manuals"
OUTPUT_DIR = ROOT / "output" / "pdf"
INDIVIDUAL_DIR = OUTPUT_DIR / "individual"
TMP_DIR = ROOT / "tmp" / "pdfs"

FONT_PATH = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
FONT_NAME = "MBoxCN"

INK = colors.HexColor("#171816")
INK_SOFT = colors.HexColor("#555A54")
GOLD = colors.HexColor("#C7A44A")
GOLD_LIGHT = colors.HexColor("#F4EBD1")
RED = colors.HexColor("#C74343")
LINE = colors.HexColor("#D9DBD6")
PAPER = colors.HexColor("#F8F8F5")
WHITE = colors.white


@dataclass(frozen=True)
class EmployeeManual:
    employee: str
    role: str
    files: tuple[str, ...]
    filename: str


EMPLOYEE_MANUALS = (
    EmployeeManual("陈方宇", "老板", ("00-common-login-and-handover.md", "01-owner-chen-fangyu.md"), "01-陈方宇-老板使用手册.pdf"),
    EmployeeManual("护古", "运营负责人", ("00-common-login-and-handover.md", "02-operations-director-hugu.md"), "02-护古-运营负责人使用手册.pdf"),
    EmployeeManual("乌鸦", "系统管理员、市场运营总监", ("00-common-login-and-handover.md", "03-admin-market-operations-wuya.md"), "03-乌鸦-管理员与市场运营使用手册.pdf"),
    EmployeeManual("挞挞", "市场设计", ("00-common-login-and-handover.md", "04-market-design-tata.md"), "04-挞挞-市场设计使用手册.pdf"),
    EmployeeManual("付淳羽", "新媒体舞台运营", ("00-common-login-and-handover.md", "05-stage-newmedia-fuchunyu.md"), "05-付淳羽-舞台与新媒体使用手册.pdf"),
    EmployeeManual("李艳", "店长、兼门迎", ("00-common-login-and-handover.md", "06-store-manager-liyan.md", "12-host-duty.md"), "06-李艳-店长与门迎使用手册.pdf"),
    EmployeeManual("冷言志", "副店长、调酒师", ("00-common-login-and-handover.md", "07-deputy-bartender-lengyanzhi.md"), "07-冷言志-副店长与调酒师使用手册.pdf"),
    EmployeeManual("三沐", "收银员", ("00-common-login-and-handover.md", "08-cashier-sanmu.md"), "08-三沐-收银员使用手册.pdf"),
    EmployeeManual("Tom", "服务员、兼门迎与取送", ("00-common-login-and-handover.md", "09-service-team.md", "12-host-duty.md"), "09-Tom-服务员与门迎使用手册.pdf"),
    EmployeeManual("Jerry", "服务员、兼门迎与取送", ("00-common-login-and-handover.md", "09-service-team.md", "12-host-duty.md"), "10-Jerry-服务员与门迎使用手册.pdf"),
    EmployeeManual("Tyke", "全店候补、服务员、兼门迎与取送", ("00-common-login-and-handover.md", "09-service-team.md", "12-host-duty.md"), "11-Tyke-全店候补与门迎使用手册.pdf"),
    EmployeeManual("申良良", "后厨", ("00-common-login-and-handover.md", "10-kitchen-shenliangliang.md"), "12-申良良-后厨使用手册.pdf"),
    EmployeeManual("阿金", "调音灯光", ("00-common-login-and-handover.md", "11-audio-lighting-ajin.md"), "13-阿金-调音灯光使用手册.pdf"),
)

COMBINED_FILES = (
    "README.md",
    "00-common-login-and-handover.md",
    "01-owner-chen-fangyu.md",
    "02-operations-director-hugu.md",
    "03-admin-market-operations-wuya.md",
    "04-market-design-tata.md",
    "05-stage-newmedia-fuchunyu.md",
    "06-store-manager-liyan.md",
    "07-deputy-bartender-lengyanzhi.md",
    "08-cashier-sanmu.md",
    "09-service-team.md",
    "10-kitchen-shenliangliang.md",
    "11-audio-lighting-ajin.md",
    "12-host-duty.md",
)


def register_fonts() -> None:
    if not FONT_PATH.exists():
        raise FileNotFoundError(f"Chinese font not found: {FONT_PATH}")
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_PATH)))
    pdfmetrics.registerFontFamily(FONT_NAME, normal=FONT_NAME, bold=FONT_NAME, italic=FONT_NAME, boldItalic=FONT_NAME)
    addMapping(FONT_NAME, 0, 0, FONT_NAME)
    addMapping(FONT_NAME, 1, 0, FONT_NAME)
    addMapping(FONT_NAME, 0, 1, FONT_NAME)
    addMapping(FONT_NAME, 1, 1, FONT_NAME)


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "cover_brand": ParagraphStyle(
            "CoverBrand", parent=base["Normal"], fontName=FONT_NAME, fontSize=12,
            leading=16, textColor=GOLD, alignment=TA_CENTER, spaceAfter=16,
        ),
        "cover_title": ParagraphStyle(
            "CoverTitle", parent=base["Title"], fontName=FONT_NAME, fontSize=27,
            leading=40, textColor=WHITE, alignment=TA_CENTER, spaceAfter=18,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle", parent=base["Normal"], fontName=FONT_NAME, fontSize=14,
            leading=22, textColor=GOLD_LIGHT, alignment=TA_CENTER, spaceAfter=10,
        ),
        "cover_meta": ParagraphStyle(
            "CoverMeta", parent=base["Normal"], fontName=FONT_NAME, fontSize=9.5,
            leading=16, textColor=colors.HexColor("#CFD1CB"), alignment=TA_CENTER,
        ),
        "h1": ParagraphStyle(
            "MBoxHeading1", parent=base["Heading1"], fontName=FONT_NAME, fontSize=19,
            leading=27, textColor=INK, spaceBefore=8, spaceAfter=11, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "MBoxHeading2", parent=base["Heading2"], fontName=FONT_NAME, fontSize=14,
            leading=21, textColor=colors.HexColor("#7C641E"), spaceBefore=12,
            spaceAfter=7, keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "MBoxHeading3", parent=base["Heading3"], fontName=FONT_NAME, fontSize=11.5,
            leading=17, textColor=INK, spaceBefore=9, spaceAfter=5, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "MBoxBody", parent=base["BodyText"], fontName=FONT_NAME, fontSize=10.3,
            leading=17, textColor=INK, alignment=TA_LEFT, spaceAfter=6,
            wordWrap="CJK", splitLongWords=True,
        ),
        "bullet": ParagraphStyle(
            "MBoxBullet", parent=base["BodyText"], fontName=FONT_NAME, fontSize=10.2,
            leading=16.5, textColor=INK, leftIndent=0, firstLineIndent=0,
            spaceAfter=2, wordWrap="CJK",
        ),
        "table_header": ParagraphStyle(
            "MBoxTableHeader", parent=base["BodyText"], fontName=FONT_NAME, fontSize=8.7,
            leading=13, textColor=WHITE, alignment=TA_LEFT, wordWrap="CJK",
        ),
        "table_cell": ParagraphStyle(
            "MBoxTableCell", parent=base["BodyText"], fontName=FONT_NAME, fontSize=8.4,
            leading=13, textColor=INK, alignment=TA_LEFT, wordWrap="CJK",
        ),
        "chapter_label": ParagraphStyle(
            "MBoxChapterLabel", parent=base["Normal"], fontName=FONT_NAME, fontSize=8.5,
            leading=11, textColor=RED, spaceAfter=3,
        ),
    }


def inline_markup(text: str) -> str:
    placeholders: list[str] = []

    def stash(value: str) -> str:
        placeholders.append(value)
        return f"@@MBOX{len(placeholders) - 1}@@"

    text = re.sub(r"`([^`]+)`", lambda m: stash(f'<font color="#8A3030">{html.escape(m.group(1))}</font>'), text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", lambda m: m.group(1), text)
    text = html.escape(text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    for index, value in enumerate(placeholders):
        text = text.replace(f"@@MBOX{index}@@", value)
    return text


def table_widths(column_count: int, available_width: float) -> list[float]:
    ratios = {
        2: (0.27, 0.73),
        3: (0.23, 0.28, 0.49),
        4: (0.15, 0.22, 0.28, 0.35),
        5: (0.12, 0.18, 0.20, 0.23, 0.27),
    }.get(column_count)
    if ratios is None:
        ratios = tuple(1 / column_count for _ in range(column_count))
    return [available_width * ratio for ratio in ratios]


def build_table(rows: list[list[str]], style_map: dict[str, ParagraphStyle], available_width: float) -> Table:
    column_count = max(len(row) for row in rows)
    normalized = [row + [""] * (column_count - len(row)) for row in rows]
    data = []
    for row_index, row in enumerate(normalized):
        paragraph_style = style_map["table_header"] if row_index == 0 else style_map["table_cell"]
        data.append([Paragraph(inline_markup(cell.strip()), paragraph_style) for cell in row])
    table = Table(
        data,
        colWidths=table_widths(column_count, available_width),
        repeatRows=1,
        hAlign="LEFT",
        splitByRow=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), (colors.white, PAPER)),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("LINEBELOW", (0, 0), (-1, 0), 1.1, GOLD),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def markdown_to_flowables(path: Path, style_map: dict[str, ParagraphStyle], available_width: float) -> list:
    lines = path.read_text(encoding="utf-8").splitlines()
    story: list = []
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if not stripped:
            index += 1
            continue

        if stripped.startswith("|"):
            table_lines = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index].strip())
                index += 1
            rows = []
            for table_line in table_lines:
                if is_table_separator(table_line):
                    continue
                rows.append([cell.strip() for cell in table_line.strip().strip("|").split("|")])
            if rows:
                story.extend([build_table(rows, style_map, available_width), Spacer(1, 7)])
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            level = len(heading.group(1))
            if level == 1:
                story.append(Paragraph("岗位手册", style_map["chapter_label"]))
            story.append(Paragraph(inline_markup(heading.group(2)), style_map[f"h{level}"]))
            index += 1
            continue

        if re.match(r"^-\s+", stripped):
            items = []
            while index < len(lines) and re.match(r"^-\s+", lines[index].strip()):
                item_text = re.sub(r"^-\s+", "", lines[index].strip())
                items.append(ListItem(Paragraph(inline_markup(item_text), style_map["bullet"]), leftIndent=10))
                index += 1
            story.append(ListFlowable(items, bulletType="bullet", bulletFontName=FONT_NAME, bulletFontSize=7, leftIndent=15, bulletColor=GOLD))
            story.append(Spacer(1, 4))
            continue

        if re.match(r"^\d+\.\s+", stripped):
            items = []
            while index < len(lines) and re.match(r"^\d+\.\s+", lines[index].strip()):
                item_text = re.sub(r"^\d+\.\s+", "", lines[index].strip())
                items.append(ListItem(Paragraph(inline_markup(item_text), style_map["bullet"]), leftIndent=12))
                index += 1
            story.append(ListFlowable(items, bulletType="1", bulletFontName=FONT_NAME, bulletFontSize=9, leftIndent=18, bulletColor=GOLD))
            story.append(Spacer(1, 4))
            continue

        paragraph_lines = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if not candidate or candidate.startswith("|") or re.match(r"^(#{1,3})\s+", candidate) or re.match(r"^-\s+", candidate) or re.match(r"^\d+\.\s+", candidate):
                break
            paragraph_lines.append(candidate)
            index += 1
        story.append(Paragraph(inline_markup(" ".join(paragraph_lines)), style_map["body"]))
    return story


def draw_cover(canvas, doc) -> None:
    width, height = A4
    canvas.saveState()
    canvas.setFillColor(INK)
    canvas.rect(0, 0, width, height, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.rect(0, height - 6 * mm, width, 6 * mm, stroke=0, fill=1)
    canvas.setStrokeColor(colors.HexColor("#514725"))
    canvas.setLineWidth(0.7)
    canvas.line(24 * mm, 28 * mm, width - 24 * mm, 28 * mm)
    canvas.setFillColor(colors.HexColor("#A9ADA7"))
    canvas.setFont(FONT_NAME, 8)
    canvas.drawCentredString(width / 2, 20 * mm, "M-BOX LIVEHOUSE · LUJIAZUI · INTERNAL OPERATIONS")
    canvas.restoreState()


def draw_content_page(canvas, doc) -> None:
    width, height = A4
    canvas.saveState()
    canvas.setFillColor(WHITE)
    canvas.rect(0, 0, width, height, stroke=0, fill=1)
    canvas.setFillColor(INK)
    canvas.setFont(FONT_NAME, 8.2)
    canvas.drawString(18 * mm, height - 13 * mm, "M-BOX 陆家嘴店 · 岗位使用手册")
    canvas.setStrokeColor(GOLD)
    canvas.setLineWidth(0.8)
    canvas.line(18 * mm, height - 16 * mm, width - 18 * mm, height - 16 * mm)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 14 * mm, width - 18 * mm, 14 * mm)
    canvas.setFillColor(INK_SOFT)
    canvas.setFont(FONT_NAME, 8)
    canvas.drawString(18 * mm, 9 * mm, "版本 1.0 · 北京时间 · 内部培训资料")
    canvas.drawRightString(width - 18 * mm, 9 * mm, f"{doc.page}")
    canvas.restoreState()


def cover_story(style_map: dict[str, ParagraphStyle], title: str, subtitle: str) -> list:
    return [
        Spacer(1, 58 * mm),
        Paragraph("M-BOX · LUJIAZUI", style_map["cover_brand"]),
        Paragraph(title, style_map["cover_title"]),
        Paragraph(subtitle, style_map["cover_subtitle"]),
        Spacer(1, 15 * mm),
        Paragraph("系统操作 · 现场职责 · 服务标准 · 异常升级", style_map["cover_meta"]),
        Paragraph("版本 1.0 · 2026年7月 · Asia/Shanghai", style_map["cover_meta"]),
        PageBreak(),
    ]


def build_pdf(output_path: Path, title: str, subtitle: str, source_files: tuple[str, ...], *, chapter_breaks: bool) -> None:
    style_map = styles()
    page_width, _ = A4
    left_margin = right_margin = 18 * mm
    available_width = page_width - left_margin - right_margin
    document = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        rightMargin=right_margin,
        leftMargin=left_margin,
        topMargin=23 * mm,
        bottomMargin=20 * mm,
        title=title,
        author="M-BOX 陆家嘴店",
        subject="岗位系统与实际工作使用手册",
        pageCompression=1,
        allowSplitting=1,
    )
    story = cover_story(style_map, title, subtitle)
    for source_index, filename in enumerate(source_files):
        if source_index and chapter_breaks:
            story.append(PageBreak())
        source = MANUAL_DIR / filename
        if not source.exists():
            raise FileNotFoundError(source)
        story.extend(markdown_to_flowables(source, style_map, available_width))
    document.build(story, onFirstPage=draw_cover, onLaterPages=draw_content_page)


def create_zip(paths: list[Path], output_path: Path) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            archive.write(path, arcname=path.name)


def main() -> None:
    register_fonts()
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    INDIVIDUAL_DIR.mkdir(parents=True, exist_ok=True)

    combined_path = OUTPUT_DIR / "MBOX-全岗位系统与实际工作使用手册-v1.0.pdf"
    build_pdf(
        combined_path,
        "全岗位系统与实际工作使用手册",
        "13名员工 · 全岗位合订本",
        COMBINED_FILES,
        chapter_breaks=False,
    )

    individual_paths = []
    for manual in EMPLOYEE_MANUALS:
        output_path = INDIVIDUAL_DIR / manual.filename
        build_pdf(
            output_path,
            f"{manual.employee} · 使用手册",
            manual.role,
            manual.files,
            chapter_breaks=False,
        )
        individual_paths.append(output_path)

    zip_path = OUTPUT_DIR / "MBOX-13名员工使用手册-PDF合集-v1.0.zip"
    create_zip([combined_path, *individual_paths], zip_path)
    print(f"combined={combined_path}")
    print(f"individual={len(individual_paths)}")
    print(f"archive={zip_path}")


if __name__ == "__main__":
    main()
