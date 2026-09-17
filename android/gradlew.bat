@rem Lanthano Research - Gradle launcher for Windows (used like the normal wrapper):
@rem
@rem     gradlew.bat assembleDebug
@rem
@rem Uses gradle\wrapper\gradle-wrapper.jar when it exists; otherwise
@rem gradle\launcher.ps1 downloads the Gradle version named in
@rem gradle\wrapper\gradle-wrapper.properties once and runs it.
@if "%DEBUG%"=="" @echo off
setlocal

set "APP_HOME=%~dp0"
if "%APP_HOME:~-1%"=="\" set "APP_HOME=%APP_HOME:~0,-1%"

set "JAVA_EXE=java.exe"
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"

if exist "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" (
    "%JAVA_EXE%" -Xmx64m -Xms64m -Dorg.gradle.appname=gradlew -classpath "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
    exit /b %ERRORLEVEL%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\launcher.ps1" %*
exit /b %ERRORLEVEL%
