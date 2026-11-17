// viberdb — strictly read-only access to Viber Desktop's encrypted viber.db.
//
// Viber encrypts viber.db with a SQLite SEE codec that is compiled into its own
// Qt SQLite driver plugin (Viber.app/Contents/PlugIns/sqldrivers/libqsqlite.dylib).
// That plugin exports no sqlite3_* symbols, so the only way in is Qt's QSqlDatabase.
// This program is compiled against Qt 6.11 headers but links Viber's *own* QtCore/QtSql
// frameworks at runtime, so the loaded Qt matches the plugin exactly.
//
// Protocol: one JSON request on stdin, one JSON response on stdout.
//   request:  {"db": "/path/viber.db", "keys": ["<hex>", ...],
//              "queries": [{"sql": "SELECT ...", "params": [..]}, ...],
//              "maxRows": 5000, "busyTimeoutMs": 5000}
//   response: {"ok": true, "keyIndex": 0, "results": [{"columns": [..], "rows": [[..]]}]}
//          or {"ok": false, "error": "..."}
//
// Read-only guarantees (defence in depth):
//   1. the connection is opened with SQLITE_OPEN_READONLY (QSQLITE_OPEN_READONLY);
//   2. PRAGMA query_only=1 is set right after keying;
//   3. only SELECT / WITH statements are accepted (plus a few introspection PRAGMAs);
//   4. Qt's QSQLITE driver prepares only the first statement of a string, so
//      "SELECT 1; DELETE ..." cannot smuggle a second statement in.
// The key is never printed. Keys arrive on stdin, not argv (argv is visible in `ps`).

#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QRegularExpression>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QSqlRecord>
#include <QStringList>
#include <QTextStream>
#include <QVariant>

#include <cstdio>
#include <iostream>
#include <iterator>
#include <string>

namespace {

void writeJson(const QJsonObject &o) {
    const QByteArray out = QJsonDocument(o).toJson(QJsonDocument::Compact);
    fwrite(out.constData(), 1, size_t(out.size()), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

int fail(const QString &msg) {
    writeJson(QJsonObject{{"ok", false}, {"error", msg}});
    return 1;
}

bool isHex(const QString &s) {
    static const QRegularExpression re(QStringLiteral("^[0-9a-fA-F]+$"));
    return !s.isEmpty() && (s.size() % 2 == 0) && re.match(s).hasMatch();
}

// Only plain reads are allowed through.
bool isAllowedSql(const QString &sql) {
    static const QRegularExpression readRe(
        QStringLiteral("^\\s*(SELECT|WITH)\\b"),
        QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression pragmaRe(
        QStringLiteral("^\\s*PRAGMA\\s+(table_info|table_xinfo|index_list|index_info|"
                       "foreign_key_list|user_version|schema_version|journal_mode)\\b"
                       "[^;=]*$"),
        QRegularExpression::CaseInsensitiveOption);
    return readRe.match(sql).hasMatch() || pragmaRe.match(sql).hasMatch();
}

QJsonValue toJson(const QVariant &v) {
    if (v.isNull() || !v.isValid()) return QJsonValue::Null;
    switch (v.typeId()) {
    case QMetaType::Bool: return v.toBool();
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::Long:
    case QMetaType::LongLong:
    case QMetaType::ULong:
    case QMetaType::ULongLong: {
        const qlonglong n = v.toLongLong();
        // JSON numbers are doubles; keep exactness for big tokens by using strings.
        if (n > (1LL << 53) || n < -(1LL << 53)) return QString::number(n);
        return double(n);
    }
    case QMetaType::Double:
    case QMetaType::Float: return v.toDouble();
    case QMetaType::QByteArray:
        return QJsonObject{{"$blob", QString::fromLatin1(v.toByteArray().toBase64())}};
    default: return v.toString();
    }
}

QVariant fromJson(const QJsonValue &j) {
    switch (j.type()) {
    case QJsonValue::Null:
    case QJsonValue::Undefined: return QVariant();
    case QJsonValue::Bool: return j.toBool() ? 1 : 0;
    case QJsonValue::Double: {
        const double d = j.toDouble();
        const qlonglong n = qlonglong(d);
        if (double(n) == d) return n;
        return d;
    }
    case QJsonValue::String: return j.toString();
    default: return QString::fromUtf8(QJsonDocument(j.toObject()).toJson(QJsonDocument::Compact));
    }
}

}  // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);

    // Viber's plugin dir (contains sqldrivers/libqsqlite.dylib with the SEE codec).
    QString viberApp = qEnvironmentVariable("VIBER_APP", QStringLiteral("/Applications/Viber.app"));
    QCoreApplication::setLibraryPaths({viberApp + QStringLiteral("/Contents/PlugIns")});

    const std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(QByteArray::fromStdString(input), &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject())
        return fail(QStringLiteral("bad request JSON: ") + perr.errorString());
    const QJsonObject req = doc.object();

    const QString dbPath = req.value("db").toString();
    if (dbPath.isEmpty() || !QFile::exists(dbPath)) return fail(QStringLiteral("db not found: ") + dbPath);
    if (!QSqlDatabase::isDriverAvailable(QStringLiteral("QSQLITE")))
        return fail(QStringLiteral("QSQLITE driver not loadable from ") + viberApp);

    const QJsonArray keys = req.value("keys").toArray();
    const QJsonArray queries = req.value("queries").toArray();
    const int maxRows = req.value("maxRows").toInt(5000);
    const int busyMs = req.value("busyTimeoutMs").toInt(5000);
    if (keys.isEmpty()) return fail(QStringLiteral("no key candidates supplied"));
    for (const auto &q : queries) {
        const QString sql = q.toObject().value("sql").toString();
        if (!isAllowedSql(sql)) return fail(QStringLiteral("rejected non-read-only SQL"));
    }

    int rc = 1;
    QStringList attempts;
    for (int i = 0; i < keys.size(); ++i) {
        const QString key = keys.at(i).toString();
        if (!isHex(key)) { attempts << QStringLiteral("#%1: not hex").arg(i); continue; }
        const QString conn = QStringLiteral("viber_ro_%1").arg(i);
        bool done = false;
        {
            QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), conn);
            db.setDatabaseName(dbPath);
            db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY;QSQLITE_ENABLE_REGEXP;QSQLITE_BUSY_TIMEOUT=%1").arg(busyMs));
            if (!db.open()) {
                attempts << QStringLiteral("#%1: open failed: %2").arg(i).arg(db.lastError().text());
            } else {
                QSqlQuery k(db);
                // Value was validated as pure hex above, so string building is safe here.
                k.exec(QStringLiteral("PRAGMA hexkey='%1'").arg(key));
                QSqlQuery probe(db);
                if (!probe.exec(QStringLiteral("SELECT count(*) FROM sqlite_master")) || !probe.next()) {
                    attempts << QStringLiteral("#%1: %2").arg(i).arg(probe.lastError().text());
                } else {
                    QSqlQuery ro(db);
                    ro.exec(QStringLiteral("PRAGMA query_only=1"));
                    QJsonArray results;
                    bool allOk = true;
                    QString err;
                    for (const auto &qv : queries) {
                        const QJsonObject qo = qv.toObject();
                        QSqlQuery q(db);
                        q.setForwardOnly(true);
                        if (!q.prepare(qo.value("sql").toString())) {
                            allOk = false; err = q.lastError().text(); break;
                        }
                        const QJsonArray params = qo.value("params").toArray();
                        for (int p = 0; p < params.size(); ++p) q.bindValue(p, fromJson(params.at(p)));
                        if (!q.exec()) { allOk = false; err = q.lastError().text(); break; }
                        QJsonArray cols;
                        const QSqlRecord rec = q.record();
                        for (int c = 0; c < rec.count(); ++c) cols.append(rec.fieldName(c));
                        QJsonArray rows;
                        bool truncated = false;
                        while (q.next()) {
                            if (rows.size() >= maxRows) { truncated = true; break; }
                            QJsonArray row;
                            for (int c = 0; c < rec.count(); ++c) row.append(toJson(q.value(c)));
                            rows.append(row);
                        }
                        results.append(QJsonObject{{"columns", cols}, {"rows", rows}, {"truncated", truncated}});
                    }
                    if (allOk) {
                        writeJson(QJsonObject{{"ok", true}, {"keyIndex", i}, {"results", results}});
                        rc = 0;
                    } else {
                        // Key is right but a query failed: report it, don't try other keys.
                        writeJson(QJsonObject{{"ok", false}, {"keyIndex", i}, {"error", QStringLiteral("query failed: ") + err}});
                        rc = 2;
                    }
                    done = true;
                }
                db.close();
            }
        }
        QSqlDatabase::removeDatabase(conn);
        if (done) return rc;
    }
    return fail(QStringLiteral("no key candidate opened the database (") + attempts.join(QStringLiteral("; ")) + ")");
}
