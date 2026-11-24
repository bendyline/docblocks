import com.bendyline.docblocks.mobile.SharedNotes;

/** Checks how shared text and files are named and written; exits non-zero on the first mismatch. */
public class SharedNotesHarness {
    private static int failures = 0;

    private static void expect(String label, String actual, String expected) {
        if (!expected.equals(actual)) {
            failures++;
            System.err.println("FAIL " + label + "\n  expected: " + expected + "\n  actual:   " + actual);
        }
    }

    public static void main(String[] args) {
        SharedNotes.Note page = SharedNotes.fromText("Raised beds: a guide", "https://example.com/beds?x=1");
        expect("page name", page.name, "Raised beds a guide.md");
        expect("page markdown", page.markdown, "# Raised beds: a guide\n\n<https://example.com/beds?x=1>\n");

        SharedNotes.Note link = SharedNotes.fromText(null, "https://www.example.org/a/b");
        expect("bare link name", link.name, "Link from example.org.md");
        expect("bare link markdown", link.markdown, "<https://www.example.org/a/b>\n");

        SharedNotes.Note passage = SharedNotes.fromText("  ", "Buy compost\r\nand mulch");
        expect("passage name", passage.name, "Buy compost.md");
        expect("passage markdown", passage.markdown, "Buy compost\nand mulch\n");

        SharedNotes.Note unsafe = SharedNotes.fromText("../../etc/passwd", "x");
        expect("unsafe subject", unsafe.name, "etc passwd.md");

        SharedNotes.Note blank = SharedNotes.fromText(null, "...");
        expect("nothing to name", blank.name, "Shared note.md");

        String longTitle = "word ".repeat(40);
        String longName = SharedNotes.fromText(longTitle, "x").name;
        expect("long name length", String.valueOf(longName.length() <= SharedNotes.MAX_NAME_CHARS + 3), "true");

        expect("markdown kept", SharedNotes.documentName("Plan.md"), "Plan.md");
        expect("text renamed", SharedNotes.documentName("notes.txt"), "notes.md");
        expect("no name", SharedNotes.documentName(null), "Shared document.md");
        expect("odd name", SharedNotes.documentName("a/b:c"), "a b c.md");
        expect("brackets kept", SharedNotes.documentName("Notes [draft].md"), "Notes [draft].md");
        expect("long extension kept", SharedNotes.documentName("Plan.MARKDOWN"), "Plan.MARKDOWN");
        // Names storage would refuse, or that would be hidden, are cleaned rather than lost.
        expect("backslash", SharedNotes.documentName("a\\b.md"), "a b.md");
        expect("drive letter", SharedNotes.documentName("C:notes.md"), "C notes.md");
        expect("hidden", SharedNotes.documentName(".plan.md"), "plan.md");
        expect("extension only", SharedNotes.documentName(".md"), "Shared document.md");
        expect("control character", SharedNotes.documentName("a\u0007b.md"), "a b.md");
        expect("device name", SharedNotes.documentName("CON.md"), "CON note.md");
        expect("device subject", SharedNotes.fromText("aux", "x").name, "aux note.md");

        String emoji = SharedNotes.fromText("🌱".repeat(60), "x").name;
        String stem = emoji.substring(0, emoji.length() - 3);
        expect("emoji not split", String.valueOf(!Character.isHighSurrogate(stem.charAt(stem.length() - 1))), "true");

        if (failures > 0) System.exit(1);
        System.out.println("SharedNotes: all checks passed");
    }
}
