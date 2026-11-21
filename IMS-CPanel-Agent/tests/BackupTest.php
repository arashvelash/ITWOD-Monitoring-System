<?php

declare(strict_types=1);

use Ims\Agent\Backup\ArchiveEncryptor;
use Ims\Agent\Backup\CronExpression;
use Ims\Agent\Backup\FileArchiver;
use Ims\Agent\Backup\Naming;
use Ims\Agent\Backup\Retention;

echo "\nBackups\n";
$v = T::vectors();

T::test('archive encryption matches the shared vector and round-trips', static function () use ($v) {
    $a = $v['archive'];
    $dir = T::tempDir();
    file_put_contents("$dir/plain", hex2bin($a['plaintextHex']));
    ArchiveEncryptor::encryptFile("$dir/plain", "$dir/enc", $a['keyBase64'], $a['chunkSize'], hex2bin($a['noncePrefixHex']));
    T::eq($a['outputHex'], bin2hex((string) file_get_contents("$dir/enc")));
    ArchiveEncryptor::decryptFile("$dir/enc", "$dir/dec", $a['keyBase64']);
    T::eq(hex2bin($a['plaintextHex']), file_get_contents("$dir/dec"));

    foreach ([0, 1, 48, 96, 5000] as $size) {
        file_put_contents("$dir/r", $size > 0 ? random_bytes($size) : '');
        ArchiveEncryptor::encryptFile("$dir/r", "$dir/r.enc", $a['keyBase64'], 48);
        ArchiveEncryptor::decryptFile("$dir/r.enc", "$dir/r.dec", $a['keyBase64']);
        T::eq(file_get_contents("$dir/r"), file_get_contents("$dir/r.dec"), "size {$size}");
    }
});

T::test('archive decryption rejects tampering and truncation', static function () use ($v) {
    $a = $v['archive'];
    $dir = T::tempDir();
    $enc = hex2bin($a['outputHex']);
    $bad = $enc;
    $bad[40] = chr(ord($bad[40]) ^ 1);
    file_put_contents("$dir/bad", $bad);
    T::throws(static function () use ($dir, $a) {
        ArchiveEncryptor::decryptFile("$dir/bad", "$dir/out", $a['keyBase64']);
    });
    file_put_contents("$dir/trunc", substr($enc, 0, 20 + 2 * (4 + 48 + 16)));
    T::throws(static function () use ($dir, $a) {
        ArchiveEncryptor::decryptFile("$dir/trunc", "$dir/out", $a['keyBase64']);
    });
});

T::test('cron expressions match like Vixie cron', static function () {
    $c = new CronExpression('*/15 3 * * 1-5');
    T::true($c->matches(new DateTimeImmutable('2026-01-05 03:30', new DateTimeZone('UTC'))), 'monday 03:30');
    T::true(!$c->matches(new DateTimeImmutable('2026-01-04 03:30', new DateTimeZone('UTC'))), 'sunday');
    T::true(!CronExpression::isValid('0 0 3 * * *'), 'six fields');
    T::true(!CronExpression::isValid('61 * * * *'), 'range');
    $dom = new CronExpression('0 0 1 * 0'); // 1st of month OR sunday
    T::true($dom->matches(new DateTimeImmutable('2026-01-04 00:00', new DateTimeZone('UTC'))), 'sunday OR');
    $daily = new CronExpression('0 3 * * *');
    $slot = $daily->latestSlot(new DateTimeImmutable('2026-01-01T00:00:00Z'), new DateTimeImmutable('2026-01-01T23:31:00Z'), 'Asia/Tehran');
    T::eq('2026-01-01T23:30:00+00:00', $slot ? $slot->setTimezone(new DateTimeZone('UTC'))->format('c') : null);
});

T::test('naming and retention only touch IMS archives', static function () {
    $name = Naming::archiveName('site', 'tar.gz', true, new DateTimeImmutable('2026-03-04T05:06:07Z'));
    T::eq('ims-site-20260304T050607Z.tar.gz.enc', $name);
    $names = ['ims-site-20260101T030000Z.tar.gz', 'ims-site-20260102T030000Z.tar.gz', 'ims-site-20260103T030000Z.tar.gz', 'important.tar.gz', 'ims-other-20250101T030000Z.tar.gz'];
    $del = Retention::selectForDeletion('site', $names, 1, null, strtotime('2026-01-05'));
    sort($del);
    T::eq(['ims-site-20260101T030000Z.tar.gz', 'ims-site-20260102T030000Z.tar.gz'], $del);
    T::eq([], Retention::selectForDeletion('site', $names, 0, null, time()));
});

T::test('file archiver produces a valid tar.gz and refuses paths outside home', static function () {
    $home = T::tempDir();
    mkdir("$home/public_html/assets", 0700, true);
    file_put_contents("$home/public_html/index.php", '<?php echo 1;');
    file_put_contents("$home/public_html/assets/app.log", 'log');
    file_put_contents("$home/public_html/assets/" . str_repeat('n', 120) . '.txt', 'long name');
    $out = "$home/out.tar.gz";
    $stats = FileArchiver::create(["$home/public_html"], ['*.log'], $home, [], $out, 6);
    T::eq(2, $stats['files']);
    // Minimal tar reader (handles GNU LongLink) to verify the archive structure and contents.
    $raw = (string) gzdecode((string) file_get_contents($out));
    $found = [];
    $longName = null;
    for ($o = 0; $o + 512 <= strlen($raw);) {
        $hdr = substr($raw, $o, 512);
        if (trim($hdr, "\0") === '') {
            break;
        }
        $sum = 0;
        for ($i = 0; $i < 512; $i++) {
            $sum += ($i >= 148 && $i < 156) ? 32 : ord($hdr[$i]);
        }
        T::eq(octdec(trim(substr($hdr, 148, 7), "\0 ")), $sum, 'header checksum');
        $size = (int) octdec(trim(substr($hdr, 124, 11)));
        $type = $hdr[156];
        $data = substr($raw, $o + 512, $size);
        $o += 512 + (int) (ceil($size / 512) * 512);
        if ($type === 'L') {
            $longName = rtrim($data, "\0");
            continue;
        }
        $name = $longName ?? rtrim(substr($hdr, 0, 100), "\0");
        $longName = null;
        if ($type === '0') {
            $found[$name] = $data;
        }
    }
    ksort($found);
    T::eq(['public_html/assets/' . str_repeat('n', 120) . '.txt' => 'long name', 'public_html/index.php' => '<?php echo 1;'], $found);
    T::throws(static function () use ($home) {
        FileArchiver::create([sys_get_temp_dir()], [], "$home/public_html", [], "$home/x.tar.gz", 6);
    });
});
