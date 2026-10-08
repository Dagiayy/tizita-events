// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Amharic (`am`).
class L10nAm extends L10n {
  L10nAm([String locale = 'am']) : super(locale);

  @override
  String get appName => 'የዝግጅት ፎቶዎች';

  @override
  String get tagline => 'ቅረጽ  ·  አጋራ  ·  አስታውስ';

  @override
  String get events => 'የእኔ ዝግጅቶች';

  @override
  String get noEvents => 'እስካሁን ዝግጅት የለም። ለመቀላቀል QR ይቃኙ ወይም ኮድ ያስገቡ።';

  @override
  String get joinEvent => 'ዝግጅት ይቀላቀሉ';

  @override
  String get scanQr => 'QR ኮድ ይቃኙ';

  @override
  String get enterCode => 'ኮድ ወይም አገናኝ ያስገቡ';

  @override
  String get codeOrLinkHint => 'የመግቢያ ኮድ ወይም አገናኝ';

  @override
  String get codeOrLinkLabel => 'ከግብዣው ላይ ያለው ኮድ ወይም አገናኝ';

  @override
  String get continueLabel => 'ቀጥል';

  @override
  String get invalidLink => 'ይህ ትክክለኛ የዝግጅት አገናኝ ወይም ኮድ አይደለም።';

  @override
  String get cameraDenied => 'ለመቃኘት የካሜራ ፈቃድ ያስፈልጋል። በምትኩ ኮዱን ማስገባት ይችላሉ።';

  @override
  String get joinCodeLabel => 'የመግቢያ ኮድ';

  @override
  String get passcodeLabel => 'የዝግጅቱ የይለፍ ቃል';

  @override
  String get nameLabel => 'ስምዎ (አማራጭ)';

  @override
  String get nameRequired => 'አስተናጋጁ እንግዶች ስማቸውን እንዲያስገቡ ይጠይቃል።';

  @override
  String get phoneLabel => 'የሞባይል ቁጥር';

  @override
  String get sendCode => 'ኮድ ላክ';

  @override
  String get smsCodeLabel => 'ባለ 6 አሃዝ ኮድ';

  @override
  String get verify => 'አረጋግጥ';

  @override
  String get noticeTitle => 'የፎቶ ማስታወቂያ';

  @override
  String get noticeAccept => 'ማስታወቂያውን አንብቤ ፎቶዎቼን ከዚህ ዝግጅት ጋር ለማጋራት ተስማምቻለሁ።';

  @override
  String get noticeDraft => 'ረቂቅ ጽሑፍ - የሕግ ግምገማ በመጠበቅ ላይ';

  @override
  String get join => 'ዝግጅቱን ይቀላቀሉ';

  @override
  String get joining => 'በመቀላቀል ላይ…';

  @override
  String hostedBy(String host) {
    return 'አስተናጋጅ፦ $host';
  }

  @override
  String get statusNotStarted => 'ዝግጅቱ ገና አልጀመረም።';

  @override
  String get statusClosed => 'መጫን ተዘግቷል። አሁንም ጋለሪውን ማየት ይችላሉ።';

  @override
  String get statusUnavailable => 'ይህ ዝግጅት አሁን አይገኝም።';

  @override
  String get uploadsOff => 'ለዚህ ዝግጅት ፎቶ መጫን ጠፍቷል።';

  @override
  String get takePhoto => 'ፎቶ ያንሱ';

  @override
  String get choosePhotos => 'ከጋለሪ ይምረጡ';

  @override
  String get viewGallery => 'ጋለሪውን ይመልከቱ';

  @override
  String get galleryLocked => 'ጋለሪውን ለማየት የጋለሪውን QR ይቃኙ ወይም ኮዱን ያስገቡ።';

  @override
  String get unlockGallery => 'ጋለሪውን ክፈት';

  @override
  String get tabCapture => 'ቀረጻ';

  @override
  String get tabQueue => 'መጫኖች';

  @override
  String get tabGallery => 'ጋለሪ';

  @override
  String get tabMine => 'የእኔ';

  @override
  String get queueEmpty => 'የሚጠብቅ መጫን የለም።';

  @override
  String get uploadQueueTitle => 'የመጫን ወረፋ';

  @override
  String get queued => 'በመጠበቅ ላይ';

  @override
  String get preparing => 'በማዘጋጀት ላይ…';

  @override
  String uploadingPct(int pct) {
    return 'በመጫን ላይ $pct%';
  }

  @override
  String retryingIn(int seconds) {
    return 'የግንኙነት ችግር። በ$seconds ሰከንድ ውስጥ እንደገና ይሞክራል';
  }

  @override
  String get waitingNetwork => 'ግንኙነት በመጠበቅ ላይ…';

  @override
  String get waitingWifi => 'ዋናውን ለመላክ ዋይፋይ በመጠበቅ ላይ';

  @override
  String get processing => 'ፎቶው በመፈተሽ ላይ…';

  @override
  String get pendingApproval => 'ተልኳል። አስተናጋጁ እስኪያጸድቅ በመጠበቅ ላይ።';

  @override
  String get approved => 'በጋለሪ ውስጥ ይታያል';

  @override
  String get rejected => 'አልታተመም';

  @override
  String get failedLabel => 'መጫን አልተሳካም';

  @override
  String get duplicate => 'ቀደም ብሎ ተጭኗል';

  @override
  String get cancelled => 'ተሰርዟል';

  @override
  String get retry => 'እንደገና ሞክር';

  @override
  String get cancel => 'ሰርዝ';

  @override
  String get remove => 'አስወግድ';

  @override
  String get deletePhoto => 'ፎቶዬን ሰርዝ';

  @override
  String sentCount(int count) {
    return '$count ፎቶ(ዎች) ተልከዋል። እናመሰግናለን!';
  }

  @override
  String capturedCount(int count) {
    return '$count ፎቶ(ዎች) ተነስተዋል';
  }

  @override
  String get usePhoto => 'ወደ ወረፋው ጨምር';

  @override
  String get discard => 'ጣል';

  @override
  String get draftsTitle => 'በዚህ መሣሪያ ላይ ያሉ ረቂቆች';

  @override
  String get deleteDraft => 'ረቂቁን ሰርዝ';

  @override
  String get draftsHint => 'ያነሷቸው ግን ገና ያልላኳቸው ፎቶዎች። መሰረዝ ከዚህ መሣሪያ ያስወግዳቸዋል።';

  @override
  String get savedOnDevice => 'በዚህ መሣሪያ ላይ ተቀምጧል። ግንኙነት ሲኖር መጫኑ በጀርባ ይቀጥላል።';

  @override
  String get galleryTitle => 'ጋለሪ';

  @override
  String get galleryEmpty => 'እስካሁን ፎቶ የለም። የመጀመሪያው አጋሪ ይሁኑ!';

  @override
  String get loadMore => 'ተጨማሪ ጫን';

  @override
  String get highlights => 'ድምቀቶች';

  @override
  String get all => 'ሁሉም';

  @override
  String get save => 'አስቀምጥ';

  @override
  String get saveToDevice => 'ወደ መሣሪያ አስቀምጥ';

  @override
  String get saved => 'ተቀምጧል';

  @override
  String get downloadOff => 'አስተናጋጁ ማውረድን አጥፍቷል።';

  @override
  String get report => 'ሪፖርት አድርግ';

  @override
  String get reportTitle => 'ይህን ፎቶ ሪፖርት ያድርጉ';

  @override
  String get reasonInappropriate => 'ተገቢ ያልሆነ';

  @override
  String get reasonPrivacy => 'የግላዊነት ስጋት / አስወግዱኝ';

  @override
  String get reasonImpersonation => 'ማስመሰል';

  @override
  String get reasonCopyright => 'የቅጂ መብት';

  @override
  String get reasonOther => 'ሌላ';

  @override
  String get reportSend => 'ሪፖርት ላክ';

  @override
  String get reportThanks => 'እናመሰግናለን። አስተናጋጁ ይህን ፎቶ ይመረምራል።';

  @override
  String get settings => 'ቅንብሮች';

  @override
  String get language => 'ቋንቋ';

  @override
  String get dataSaver => 'ዳታ ቆጣቢ';

  @override
  String get dataSaverHint => 'ትንሽ ፎቶዎች እና አነስተኛ ዳታ። በሞባይል ዳታ ላይ ይመከራል።';

  @override
  String get wifiOnlyOriginals => 'ዋናዎቹን በዋይፋይ ብቻ ላክ';

  @override
  String get wifiOnlyOriginalsHint =>
      'በሞባይል ዳታ ላይ ትንሽ ስሪት ይላካል። ዋናው የሚላከው በዋይፋይ ላይ ሲሆኑ ብቻ ነው።';

  @override
  String get notificationsLabel => 'ማሳወቂያዎች';

  @override
  String get notificationsHint =>
      'ፎቶዎችዎ ሲጸድቁ ወይም ዝግጅት ሲዘጋ በስልክዎ ላይ ማሳወቂያ። የሶስተኛ ወገን የፑሽ አገልግሎት አይጠቀምም።';

  @override
  String get dataUsage => 'በመጫኖች የተጠቀሙት ዳታ';

  @override
  String dataUsageMobile(String size) {
    return 'የሞባይል ዳታ፦ $size';
  }

  @override
  String dataUsageWifi(String size) {
    return 'ዋይፋይ፦ $size';
  }

  @override
  String get dataUsageReset => 'ቆጣሪዎችን አጥፋ';

  @override
  String get leaveEvent => 'ዝግጅቱን ልቀቅ';

  @override
  String get leaveEventConfirm =>
      'ይህን ዝግጅት ከዚህ ስልክ ላይ ላስወግድ? ቀደም ብለው የተጫኑ ፎቶዎች በጋለሪ ውስጥ ይቆያሉ።';

  @override
  String get privacyRequests => 'የግላዊነት እና የማስወገድ ጥያቄዎች';

  @override
  String privacyBody(String host) {
    return 'የግል መረጃን ለማየት፣ ለማስወገድ ወይም ለመገደብ ድረ ገጹን ይጠቀሙ፦ $host/privacy';
  }

  @override
  String ethiopianDate(String date) {
    return 'የኢትዮጵያ ቀን፦ $date';
  }

  @override
  String get errGeneric => 'የሆነ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።';

  @override
  String get errNetwork => 'ግንኙነት የለም። አውታረ መረብዎን ፈትሸው እንደገና ይሞክሩ።';

  @override
  String get errRateLimited => 'በጣም ብዙ ሙከራዎች። እባክዎ ጥቂት ይጠብቁ።';

  @override
  String get errOtpInvalid => 'ኮዱ ትክክል አይደለም ወይም ጊዜው አልፏል።';

  @override
  String get errEventNotFound => 'ይህን ዝግጅት ማግኘት አልቻልንም። አገናኙን ወይም ኮዱን ያረጋግጡ።';

  @override
  String get errCredentialRequired => 'ለመቀጠል ኮድ ወይም የይለፍ ቃል ያስፈልጋል።';

  @override
  String get errConsentRequired => 'ፎቶ ለመጫን እባክዎ የፎቶ ማስታወቂያውን ይቀበሉ።';

  @override
  String get errFileTooLarge => 'ይህ ፎቶ በጣም ትልቅ ነው (ቢበዛ 15 ሜጋባይት)።';

  @override
  String get errUnsupportedType => 'JPEG፣ PNG፣ WebP ወይም HEIC ፎቶዎች ብቻ ይደገፋሉ።';

  @override
  String get errStorageFull => 'የዚህ ዝግጅት ማከማቻ ሞልቷል።';

  @override
  String get errMediaLimit => 'ይህ ዝግጅት የፎቶ ገደቡ ላይ ደርሷል።';

  @override
  String get errOutsideWindow => 'መጫን አሁን ክፍት አይደለም።';

  @override
  String get errSessionBlocked => 'ከእንግዲህ ወደዚህ ዝግጅት ማስገባት አይችሉም።';

  @override
  String get errSessionExpired => 'ክፍለ ጊዜዎ አልቋል። የዝግጅቱን አገናኝ እንደገና ይክፈቱ።';

  @override
  String get errEventState => 'በዚህ የዝግጅት ደረጃ ይህ አይቻልም።';

  @override
  String get people => 'ሰዎች';

  @override
  String get you => 'እርስዎ';

  @override
  String get guestUnnamed => 'እንግዳ';

  @override
  String get yours => 'የእርስዎ';

  @override
  String get noPeople =>
      'ስም ያላቸው ላኪዎች እስካሁን የሉም። እንግዶች ስማቸውን ሲያስገቡ ፎቶዎች እዚህ ይታያሉ።';

  @override
  String get layoutGrid => 'ፍርግርግ';

  @override
  String get layoutMasonry => 'ኮላጅ';

  @override
  String get layoutList => 'ትልቅ';

  @override
  String get layoutBySender => 'በላኪ';

  @override
  String photosCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count ፎቶዎች',
      one: '1 ፎቶ',
    );
    return '$_temp0';
  }

  @override
  String get minePhotosEmpty => 'ወደዚህ ዝግጅት እስካሁን ምንም ፎቶ አልጨመሩም።';

  @override
  String get allPeople => 'ሁሉም ሰዎች';

  @override
  String get getStarted => 'ጀምር';

  @override
  String get splashPromise => 'ትዝታዎችዎ፣\nበጋራ።';
}
