PRE-ROUND-1 DEFECTS (found during harness bring-up, to verify in R1 and fix for R2):

D1 [HIGH] Live vision (G10) never fires. main.py builds _image_bytes_list only from a JSON
   content {attachments:[{type:image,name}]} at S3 key users/<u>/staging/wa-<msgId>/<name>.
   - admin-test sends kind='image' with payload.url=presigned + plain-text content -> no attachments parsed -> empty image list.
   - telegram/whatsapp inbound photos go to nanoclaw:uploads:pending (indexer/OCR), NOT a live vision message.
   => "describe this image" gets no image on ALL channels. Photos are only queryable later via RAG once indexed.
   FIX (R2): in main.py dispatch, when payload kind=='image' and payload.url present, fetch the URL bytes
   (presigned S3 or http) into _image_bytes_list directly; keep the existing attachments path too.

D2 [MED] Reminder "tomorrow at 9am" parse: split on ' at ' first puts 'tomorrow' into reminder TEXT,
   time becomes bare '9am' -> fires today/tomorrow by bare-time rule, not guaranteed actual tomorrow.
   FIX (R2): detect day-words (tomorrow/today/weekday) on the LEFT side and fold into the time string.

D3 [INFO] G9 doc QA is async: upload -> indexer -> ask. Harness must wait between upload and question.
