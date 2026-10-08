# Reproducible Android APK build (Flutter). Not a long-running service: it builds and copies the APK to /out.
#   docker compose -f infra/docker-compose.yml --env-file .env --profile mobile run --rm mobile-build
#   -> dist/mobile/app-release.apk (debug-signed unless android/key.properties + keystore are mounted)
# Toolchain (JDK, Android SDK, Flutter) is downloaded at image build time only; nothing here runs in production.
FROM eclipse-temurin:17-jdk-jammy
ARG FLUTTER_VERSION=3.44.8
ARG ANDROID_CMDLINE_TOOLS=11076708
ARG API_BASE=https://photos.example.et
ARG WEB_HOST=photos.example.et
ARG BUILD_MODE=release
ENV API_BASE=$API_BASE WEB_HOST=$WEB_HOST BUILD_MODE=$BUILD_MODE \
    ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk FLUTTER_HOME=/opt/flutter \
    PUB_CACHE=/root/.pub-cache CI=true
ENV PATH=$PATH:/opt/flutter/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip xz-utils git ca-certificates libglu1-mesa \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/android-sdk/cmdline-tools \
  && curl -fsSL --retry 5 -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip \
  && unzip -q /tmp/cmdtools.zip -d /opt/android-sdk/cmdline-tools && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
  && rm /tmp/cmdtools.zip \
  && yes | sdkmanager --licenses >/dev/null \
  && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

RUN curl -fsSL --retry 5 -o /tmp/flutter.tar.xz https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz \
  && tar -xf /tmp/flutter.tar.xz -C /opt && rm /tmp/flutter.tar.xz \
  && git config --global --add safe.directory /opt/flutter \
  && flutter config --no-analytics --no-cli-animations \
  && flutter precache --android

WORKDIR /app
COPY pubspec.yaml pubspec.lock ./
RUN flutter pub get
COPY . .
RUN flutter pub get
CMD ["sh", "-c", "flutter build apk --${BUILD_MODE} --dart-define=API_BASE=${API_BASE} --dart-define=WEB_HOST=${WEB_HOST} && mkdir -p /out && cp build/app/outputs/flutter-apk/app-${BUILD_MODE}.apk /out/ && ls -la /out"]
