package com.bendyline.docblocks.mobile;
import android.content.Context;
import android.net.Uri;
import androidx.test.platform.app.InstrumentationRegistry;
import com.bendyline.gezel.runtime.GezelNativeRuntime;
import com.bendyline.gezel.runtime.NativeCall;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real bundled llama.cpp inference; random fixture weights do not test answer quality. */
public class MobileAiFixtureTest {
    private JSONObject call(JSONObject input, Consumer<NativeCall> operation) throws Exception {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        operation.accept(new NativeCall(input, new NativeCall.Reply() {
            public void resolve(JSONObject value) { result.complete(value); }
            public void reject(String message, String code) { result.completeExceptionally(new IllegalStateException(code + ": " + message)); }
        }));
        return result.get(90, TimeUnit.SECONDS);
    }
    @Test public void pluginRegistrationAndLifecycleDoNotStartAi() throws Exception {
        var plugin = new com.bendyline.gezel.capacitor.GezelRuntimePlugin();
        plugin.load();
        var field = plugin.getClass().getDeclaredField("runtime");
        field.setAccessible(true);
        assertNull(field.get(plugin));
        for (String name : new String[]{"handleOnStart", "handleOnStop", "handleOnDestroy"}) {
            var method = plugin.getClass().getDeclaredMethod(name);
            method.setAccessible(true);
            method.invoke(plugin);
            assertNull("Opt-out lifecycle initialized AI", field.get(plugin));
        }
    }
    @Test public void importsAndGeneratesWithPackagedRuntime() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("Only the isolated test app may receive synthetic weights", "com.bendyline.docblocks.mobile.tests", context.getPackageName());
        GezelNativeRuntime runtime = GezelNativeRuntime.shared(context);
        runtime.onForeground();
        File fixture = new File(context.getCacheDir(), "DocBlocks-AI-test-fixture.gguf");
        try {
            try (var input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("mobile-ai-fixture.gguf"); var output = new FileOutputStream(fixture)) { input.transferTo(output); }
            JSONObject imported = call(new JSONObject(), nativeCall -> runtime.importModel(nativeCall, Uri.fromFile(fixture))).getJSONObject("model");
            String modelId = imported.getString("id");
            call(new JSONObject().put("id", modelId), runtime::selectModel);
            JSONObject response = call(new JSONObject().put("requestId", UUID.randomUUID().toString()).put("providerId", "llama-cpp").put("modelId", modelId).put("contextSize", 512).put("maxTokens", 8).put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "Hello"))), runtime::generate);
            assertTrue(response.has("text"));
            assertTrue(response.getString("stopReason").equals("stop") || response.getString("stopReason").equals("length"));
            assertTrue(call(new JSONObject(), runtime::providers).getJSONArray("providers").length() > 0);
        } finally { fixture.delete(); runtime.onBackground(); }
    }
}
