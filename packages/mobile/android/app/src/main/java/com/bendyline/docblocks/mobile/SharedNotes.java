package com.bendyline.docblocks.mobile;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What another app shares becomes a Markdown document: a link or a passage
 * becomes a note, and a shared text file keeps its text under a Markdown name.
 * Plain Java, so the JVM harness tests it without a device.
 */
public final class SharedNotes {
    private SharedNotes() {}

    public static final int MAX_NAME_CHARS = 80;
    private static final Pattern LINK = Pattern.compile("https?://[^\\s<>]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern UNSAFE = Pattern.compile("[\\\\/:*?\"<>|\\p{Cntrl}#\\[\\]]+");
    /** Characters device storage refuses, or that other file systems cannot hold. */
    private static final Pattern REFUSED = Pattern.compile("[\\\\/:*?\"<>|\\p{Cntrl}]");
    /** Names Windows keeps for devices, with or without an extension. */
    private static final Pattern DEVICE = Pattern.compile("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?");

    public static final class Note {
        public final String name, markdown;
        Note(String name, String markdown) { this.name = name; this.markdown = markdown; }
    }

    /** A note from shared text and its subject (either may be null or blank). */
    public static Note fromText(String subject, String text) {
        String body = text == null ? "" : text.replace("\r\n", "\n").trim();
        String heading = subject == null ? "" : subject.replaceAll("\\s+", " ").trim();
        // A bare link becomes an autolink, so it is a link in every Markdown reader.
        if (LINK.matcher(body).matches()) body = "<" + body + ">";
        String title = !heading.isEmpty() ? heading : titleFromBody(body);
        StringBuilder markdown = new StringBuilder();
        if (!heading.isEmpty()) markdown.append("# ").append(heading.replace("\n", " ")).append("\n\n");
        markdown.append(body).append('\n');
        return new Note(fileName(title, "Shared note") + ".md", markdown.toString());
    }

    /**
     * The name a shared or opened file is kept under: Markdown names as they
     * are, a text file renamed to Markdown, and a missing name made up. A
     * Markdown name that storage would refuse, or that would be hidden, is
     * cleaned rather than kept, so the file is not lost.
     */
    public static String documentName(String displayName) {
        String name = displayName == null ? "" : displayName.trim();
        String lower = name.toLowerCase(Locale.ROOT);
        String extension = lower.endsWith(".markdown") ? name.substring(name.length() - 9)
            : lower.endsWith(".md") ? name.substring(name.length() - 3) : null;
        if (extension != null) {
            String stem = name.substring(0, name.length() - extension.length());
            boolean keep = !name.startsWith(".") && name.length() <= 255 && !stem.trim().isEmpty()
                && !REFUSED.matcher(name).find() && !DEVICE.matcher(stem.trim()).matches();
            return keep ? name : fileName(stem, "Shared document") + extension;
        }
        if (lower.endsWith(".txt")) return fileName(name.substring(0, name.length() - 4), "Shared document") + ".md";
        return fileName(name, "Shared document") + ".md";
    }

    private static String titleFromBody(String body) {
        Matcher link = LINK.matcher(body);
        if (link.find() && link.start() <= 1) {
            String rest = body.substring(link.start()).replaceFirst("(?i)^<?https?://", "");
            String host = rest.split("[/?#>:]", 2)[0].replaceFirst("(?i)^www\\.", "");
            if (!host.isEmpty()) return "Link from " + host;
        }
        for (String line : body.split("\n")) {
            String clean = line.replaceFirst("^#+\\s*", "").trim();
            if (!clean.isEmpty()) return clean;
        }
        return "";
    }

    /** A file name that is safe on every platform DocBlocks syncs to. */
    static String fileName(String title, String fallback) {
        String clean = UNSAFE.matcher(title == null ? "" : title).replaceAll(" ").replaceAll("\\s+", " ").trim();
        clean = clean.replaceAll("^[.\\s]+|[.\\s]+$", "");
        if (clean.length() > MAX_NAME_CHARS) {
            int cut = clean.lastIndexOf(' ', MAX_NAME_CHARS);
            int end = cut > MAX_NAME_CHARS / 2 ? cut : MAX_NAME_CHARS;
            // Never split an emoji or other character outside the basic plane.
            if (Character.isHighSurrogate(clean.charAt(end - 1))) end--;
            clean = clean.substring(0, end).replaceAll("[.\\s]+$", "");
        }
        if (clean.isEmpty()) return fallback;
        return DEVICE.matcher(clean).matches() ? clean + " note" : clean;
    }
}
