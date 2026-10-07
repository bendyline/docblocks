import com.bendyline.docblocks.mobile.Storage;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Paths;
import java.util.Collections;
public class StorageHarness {
    public static void main(String[] args) throws Exception {
        Storage storage = new Storage(Collections.singletonMap("local", Paths.get(args[0])));
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in)); String line;
        while ((line = reader.readLine()) != null) { System.out.println(storage.request(new JSONObject(line)).toString()); System.out.flush(); }
        storage.shutdown();
    }
}
