import com.android.tools.smali.dexlib2.DexFileFactory;
import com.android.tools.smali.dexlib2.Opcodes;
import com.android.tools.smali.dexlib2.iface.ClassDef;
import com.android.tools.smali.dexlib2.writer.io.FileDataStore;
import com.android.tools.smali.dexlib2.writer.pool.DexPool;

import java.io.File;

/** Replaces one class family in an existing dex while preserving every other class. */
public final class DexClassReplacer {
  private DexClassReplacer() {}

  public static void main(String[] args) throws Exception {
    if (args.length != 4) {
      throw new IllegalArgumentException(
          "Usage: DexClassReplacer <original.dex> <patch.dex> <descriptor-prefix> <output.dex>");
    }

    // The source APK supports Android 6 and uses DEX 035. Writing a newer DEX
    // magic with the older header layout produces an APK that signs correctly
    // but is rejected by ART at launch, so preserve the APK's DEX 035 format.
    Opcodes opcodes = Opcodes.forApi(23);
    var original = DexFileFactory.loadDexFile(new File(args[0]), opcodes);
    var patch = DexFileFactory.loadDexFile(new File(args[1]), opcodes);
    DexPool output = new DexPool(opcodes);

    int removed = 0;
    for (ClassDef classDef : original.getClasses()) {
      if (classDef.getType().startsWith(args[2])) {
        removed++;
      } else {
        output.internClass(classDef);
      }
    }

    int added = 0;
    for (ClassDef classDef : patch.getClasses()) {
      if (!classDef.getType().startsWith(args[2])) {
        throw new IllegalArgumentException("Unexpected patch class: " + classDef.getType());
      }
      output.internClass(classDef);
      added++;
    }

    if (removed == 0 || added == 0) {
      throw new IllegalStateException("Replacement did not match classes: removed=" + removed +
          ", added=" + added);
    }

    FileDataStore store = new FileDataStore(new File(args[3]));
    try {
      output.writeTo(store);
    } finally {
      store.close();
    }
    System.out.println("Replaced " + removed + " classes with " + added + " classes.");
  }
}
