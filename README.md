# ieulearn-mcp

İzmir Ekonomi Üniversitesi **IEULearn** (learn.ieu.edu.tr) ve **Panopto** ders kayıtları için bir [MCP](https://modelcontextprotocol.io) sunucusu. Claude gibi bir yapay zeka asistanı dersleri, ödevleri, sınav takvimini, ders içeriğini ve hocanın ders anlatımını (zaman damgalı metin olarak) okuyabilir.

*An MCP server for Izmir University of Economics' IEULearn LMS and its Panopto lecture recordings: courses, assignments, exam schedule, course content and timestamped lecture transcripts.*

- Bağımlılık yok: yalnızca Node 22+ (ses tanıma için ffmpeg).
- Salt okunur: siteye ödev göndermez, hiçbir şeyi değiştirmez.
- Şifre yalnızca bu bilgisayarda kalır (ortam değişkeni ya da `.env`); araç yanıtlarına ve yapay zekaya gitmez.
- Gayri resmi bir araçtır, üniversiteyle bağı yoktur. Kendi hesabınızla, kendi verileriniz için kullanın.

## Araçlar

| Araç | Ne döndürür |
|---|---|
| `list_courses` | Bu dönemin dersleri (kod, ad, IEULearn numarası) |
| `list_assignments` | Ödevler: durum, son teslim, bağlantı |
| `list_exams` | Sınav takvimi (analytics.ieu.edu.tr) |
| `course_content` | Dersin haftalık planı ve dosya listesi |
| `read_learn_page` | Herhangi bir `/student...` sayfasının metni (duyuru, ödev ayrıntısı vb.) |
| `panopto_videos` | Dersin Panopto kayıtları: tarih, süre, altyazı var mı |
| `panopto_transcript` | Kaydın `[12:34] ...` biçiminde konuşma metni |

Panopto'ya IEULearn'deki Panopto aracının kullandığı LTI 1.3 girişiyle bağlanılır. Kaydın altyazısı yoksa ses yazıya çevrilir: OpenAI uyumlu bir konuşma tanıma uç noktası (varsayılan [EVREN](https://evren-llmapi.ssyz.org.tr), `qwen3-asr-1.7b`) ya da yerel [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Metin önbelleğe yazılır (`~/.ieulearn-mcp`), aynı kayıt ikinci kez anında gelir. Uzun bir dersin ilk çevrimi dakikalar sürebilir.

## Kurulum

```bash
git clone https://github.com/ErdemOzbaykus/ieulearn-mcp.git
cd ieulearn-mcp
cp .env.example .env   # IEU_USER ve IEU_PASS'ı doldurun
npm test
```

Ses tanıma için: `brew install ffmpeg`, sonra `.env`'de `ASR_API_KEY` (EVREN anahtarı) ya da `brew install whisper-cpp` ve bir model (`WHISPER_MODEL=/tam/yol/ggml-large-v3-turbo-q5_0.bin`).

### Claude Code

```bash
claude mcp add ieulearn -s user -- node /tam/yol/ieulearn-mcp/index.js
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ieulearn": { "command": "node", "args": ["/tam/yol/ieulearn-mcp/index.js"] }
  }
}
```

Ayarlar `.env` yerine ortam değişkeniyle de verilebilir (`IEU_USER`, `IEU_PASS`, `ASR_API_KEY`, `WHISPER_MODEL`, `IEULEARN_CACHE`); başka bir yerdeki ayar dosyası için `IEULEARN_ENV_FILE`. Tüm seçenekler: [.env.example](.env.example).

## Örnek istekler

- "Bu hafta teslimi olan ödevlerim neler?"
- "MCE412'nin son ders kaydında hoca neyi anlattı? Önemli formülleri zaman damgasıyla çıkar."
- "Sınavlarıma göre bir çalışma planı yap."

## İlgili

[Lecting](https://github.com/ErdemOzbaykus/lecting): aynı bağlantıyla ders dosyalarından ve Panopto kayıtlarından not, test ve sesli özet üreten yerel çalışma masası.

## Lisans

MIT, bkz. [LICENSE](LICENSE).
