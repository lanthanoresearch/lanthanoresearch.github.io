import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * The web app is NOT copied into this source tree. At build time it is taken
 * from the Lanthano Research site folder (the repository root by default) and
 * packaged into the APK under assets/www. Override with -Planthano.webRoot=<dir>.
 */
val lanthanoWebRoot: File = providers.gradleProperty("lanthano.webRoot")
    .map { rootProject.file(it) }
    .getOrElse(rootProject.projectDir.parentFile)

/** Repository files that are not part of the web app itself. */
val lanthanoWebExcludes = listOf(
    "android/**",
    ".git/**",
    ".github/**",
    ".gradle/**",
    "node_modules/**",
    "scripts/**",
    "**/.DS_Store",
    "**/Thumbs.db",
    ".gitignore",
    ".gitattributes",
    "README.md",
    "CNAME",
    "package.json",
    "package-lock.json",
    "build-search.js",
    "sw.js",
    "**/*.apk",
)

abstract class PrepareWebAssetsTask : DefaultTask() {
    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Input
    abstract val excludes: ListProperty<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val webFiles: FileTree
        get() = webRoot.get().asFileTree.matching { exclude(excludes.get()) }

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fileOps: FileSystemOperations

    @TaskAction
    fun prepare() {
        val root = webRoot.get().asFile
        val required = listOf(
            "index.html",
            "pdf.html",
            "descriptions.json",
            "search-index.json",
            "pdfjs/build/pdf.mjs",
            "pdfjs/build/pdf.worker.mjs",
        )
        val missing = required.filterNot { File(root, it).isFile }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Lanthano web root '$root' is missing ${missing.joinToString()}. " +
                    "Put the android/ folder inside the site repository, or pass -Planthano.webRoot=<site folder>.",
            )
        }
        val destination = outputDir.get().asFile
        val patterns = excludes.get()
        fileOps.sync {
            from(root) {
                exclude(patterns)
                into("www")
            }
            into(destination)
        }
        val pdfCount = File(destination, "www").walkTopDown().count { it.isFile && it.extension.equals("pdf", true) }
        val fileCount = File(destination, "www").walkTopDown().count { it.isFile }
        logger.lifecycle("Lanthano: bundled $fileCount web files ($pdfCount PDFs) from $root")
    }
}

val prepareWebAssets = tasks.register<PrepareWebAssetsTask>("prepareLanthanoWebAssets") {
    webRoot.set(lanthanoWebRoot)
    excludes.set(lanthanoWebExcludes)
}

val releaseKeystorePath: String? = System.getenv("LANTHANO_KEYSTORE_FILE")
val hasReleaseKey = !releaseKeystorePath.isNullOrBlank() && File(releaseKeystorePath).isFile

android {
    namespace = "com.lanthano.research"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.lanthano.research"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = File(releaseKeystorePath!!)
                storePassword = System.getenv("LANTHANO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LANTHANO_KEY_ALIAS")
                keyPassword = System.getenv("LANTHANO_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    androidResources {
        // Keep media uncompressed so it can be streamed with byte ranges (seeking).
        noCompress += listOf("mp3", "mp4", "m4a", "m4v", "webm", "ogg", "wav", "aac", "flac")
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWebAssets, PrepareWebAssetsTask::outputDir)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
