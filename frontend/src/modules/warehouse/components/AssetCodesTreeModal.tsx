// @ts-nocheck
import React, { useState, useMemo, useEffect } from 'react';
import { Modal, Input, Button, Typography, Tag, Row, Col, Checkbox, Card, Space, Tooltip, Empty, Pagination, Select, Divider } from 'antd';
import {
  SearchOutlined, DownloadOutlined, BarcodeOutlined, CheckCircleFilled,
  PrinterOutlined, QrcodeOutlined, ReloadOutlined, LockOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { QRCodeSVG } from 'qrcode.react';

const { Text } = Typography;
const { Option } = Select;

const AssetCodesTreeModal = ({
  open,
  onCancel,
  onSave,
  selectedCodes = [],
  rawRows = [],
  itemCode = '',
  itemName = '',
  itemType = 'asset',
  batchIds = [],
  binIds = [],
  targetQty = 0,
  lockedCodes = {},
  autoSelectOnOpen = true,
  serialDetails = {},
}) => {
  const [selected, setSelected] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBatchFilter, setSelectedBatchFilter] = useState('ALL');
  const [selectedBinFilter, setSelectedBinFilter] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 24;

  const isAsset = itemType === 'asset';
  const isConsumable = itemType === 'consumable';
  const isSerial = !isAsset && !isConsumable;

  // Flattened list of all codes with their Location/Bin/Batch metadata
  const allCodesWithMetadata = useMemo(() => {
    const list = [];
    
    // Filter rawRows by batch and bin selections from the row (if selected in the table row)
    const filteredRows = rawRows.filter((row) => {
      if (batchIds && batchIds.length > 0) {
        if (!batchIds.some(bId => String(bId) === String(row.batch_id))) {
          return false;
        }
      }
      if (binIds && binIds.length > 0) {
        if (!binIds.some(bId => String(bId) === String(row.bin_id))) {
          return false;
        }
      }
      return true;
    });

    filteredRows.forEach((row) => {
      const locName = row.location || 'Main Area';
      const rackName = row.rack || 'No Rack';
      const binName = row.bin_name || row.bin_code || 'No Bin';
      const batchName = row.batch_number || 'No Batch';
      
      let codes = [];
      if (isAsset) {
        codes = row.asset_codes || [];
      } else if (isConsumable) {
        codes = row.consumable_codes || [];
      } else {
        codes = row.serial_numbers || [];
      }
      
      codes.forEach(code => {
        list.push({
          code,
          location: locName,
          rack: rackName,
          bin: binName,
          batch: batchName,
          rowRef: row
        });
      });
    });
    return list;
  }, [rawRows, batchIds, binIds, isAsset, isConsumable]);

  // Extract unique batches and bins for dropdown filters
  const uniqueBatches = useMemo(() => {
    const map = new Map();
    allCodesWithMetadata.forEach(c => {
      if (c.rowRef.batch_id) {
        map.set(c.rowRef.batch_id, c.batch);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allCodesWithMetadata]);

  const uniqueBins = useMemo(() => {
    const map = new Map();
    allCodesWithMetadata.forEach(c => {
      if (c.rowRef.bin_id) {
        map.set(c.rowRef.bin_id, c.bin);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allCodesWithMetadata]);

  // Filtered codes list
  const filteredCodes = useMemo(() => {
    return allCodesWithMetadata.filter(c => {
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesCode = c.code.toLowerCase().includes(query);
        const matchesLoc = c.location.toLowerCase().includes(query);
        const matchesBin = c.bin.toLowerCase().includes(query);
        const matchesBatch = c.batch.toLowerCase().includes(query);
        if (!matchesCode && !matchesLoc && !matchesBin && !matchesBatch) {
          return false;
        }
      }
      if (selectedBatchFilter !== 'ALL' && String(c.rowRef.batch_id) !== String(selectedBatchFilter)) {
        return false;
      }
      if (selectedBinFilter !== 'ALL' && String(c.rowRef.bin_id) !== String(selectedBinFilter)) {
        return false;
      }
      return true;
    });
  }, [allCodesWithMetadata, searchQuery, selectedBatchFilter, selectedBinFilter]);

  // Paginated subset of filtered codes
  const paginatedCodes = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredCodes.slice(start, start + pageSize);
  }, [filteredCodes, currentPage]);

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedBatchFilter, selectedBinFilter]);

  const handleSearchSubmit = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    
    // Check if it's a multi-line QR scan payload
    let code = trimmed;
    if (trimmed.includes('\n')) {
      const lines = trimmed.split('\n');
      const codeLine = lines.find(l => l.trim().startsWith('Code:'));
      code = codeLine ? codeLine.replace('Code:', '').trim() : lines[0].trim();
    }
    
    const item = allCodesWithMetadata.find(c => c.code.toLowerCase() === code.toLowerCase());
    if (item) {
      const isLocked = lockedCodes && !!lockedCodes[item.code];
      if (!isLocked) {
        setSelected(prev =>
          prev.includes(item.code) ? prev : [...prev, item.code]
        );
      }
    }
    setSearchQuery(''); // clear query for next scan
  };

  const handleSearchChange = (val) => {
    if (val.includes('\n')) {
      handleSearchSubmit(val);
    } else {
      setSearchQuery(val);
    }
  };

  const scannedQRPayload = useMemo(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return null;
    
    const matchedCode = allCodesWithMetadata.find(c => c.code.toLowerCase() === trimmed.toLowerCase())?.code;
    if (matchedCode) {
      const details = serialDetails && serialDetails[matchedCode];
      return {
        code: matchedCode,
        mfgdate: details?.mfg_date || '-',
        expiry: details?.expiry_date || '-',
        warranty: details?.warranty_expiry || '-',
      };
    }
    
    if (searchQuery.includes('\n')) {
      const info = {};
      searchQuery.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim().toLowerCase();
          const value = parts.slice(1).join(':').trim();
          info[key] = value;
        }
      });
      return {
        code: info.code || '-',
        mfgdate: info.mfgdate || '-',
        expiry: info.expiry || '-',
        warranty: info.warranty || '-',
      };
    }
    
    return null;
  }, [searchQuery, allCodesWithMetadata, serialDetails]);

  // Synchronize on open and perform Auto-Fill if empty
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      setSelectedBatchFilter(batchIds && batchIds.length > 0 ? String(batchIds[0]) : 'ALL');
      setSelectedBinFilter('ALL');
      
      if (selectedCodes.length > 0) {
        // Map short codes (e.g. "1029") to their matching full codes (e.g. "151110-0004-1-1029")
        const mapped = selectedCodes.map(selCode => {
          const matched = allCodesWithMetadata.find(c => 
            c.code === selCode || 
            c.code.endsWith(`-${selCode}`) ||
            (itemCode && c.code === `${itemCode}-1-${selCode}`)
          );
          return matched ? matched.code : selCode;
        });
        setSelected(mapped);
      } else {
        setSelected([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allCodesWithMetadata, selectedCodes, batchIds]);

  const toggleCode = (code) => {
    if (lockedCodes && lockedCodes[code]) return;
    setSelected(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    );
  };

  const handleClearAll = () => {
    const unlocked = selected.filter(code => lockedCodes && lockedCodes[code]);
    setSelected(unlocked);
  };

  const handleSaveClick = () => {
    onSave(selected);
  };

  // Helper for generating standard text QR payloads
  const getPayloadForCode = (code, record) => {
    const matCode = itemCode || '-';
    const name = itemName || '-';
    const batch = record.batch_number || record.batch_name || '-';
    const wh = record.warehouse_name || '-';
    
    const details = serialDetails && serialDetails[code];
    const expRaw = details?.expiry_date || record.expiry_date;
    const exp = expRaw ? dayjs(expRaw).format('YYYY-MM-DD') : '-';
    
    const mfgRaw = details?.mfg_date || record.mfg_date;
    const mfg = mfgRaw ? dayjs(mfgRaw).format('YYYY-MM-DD') : '-';
    
    const warrantyRaw = details?.warranty_expiry || record.warranty_expiry;
    const warranty = warrantyRaw ? dayjs(warrantyRaw).format('YYYY-MM-DD') : '-';
    
    let payload = `Material: ${matCode}\nItem: ${name}\nBatch: ${batch}\nCode: ${code}\nWarehouse: ${wh}\nMfgDate: ${mfg}`;
    if (isAsset) {
      payload += `\nWarranty: ${warranty}`;
    } else {
      payload += `\nExpiry: ${exp}`;
    }
    return payload;
  };

  // Single code download handler
  const handleDownloadQRCode = (code, record) => {
    const payload = getPayloadForCode(code, record);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `https://bwipjs-api.metafloor.com/?bcid=qrcode&text=${encodeURIComponent(payload)}&scale=4`;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 354;
      canvas.height = 295;
      const ctx = canvas.getContext('2d');
      
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      const qrSize = 255;
      const qrX = Math.floor((canvas.width - qrSize) / 2);
      const qrY = Math.floor((canvas.height - qrSize) / 2);
      
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `qrcode_${code}.png`;
      a.click();
    };
  };

  // Sequential batch downloader
  const handleDownloadAllSelectedQRs = async () => {
    if (selected.length === 0) return;
    for (let i = 0; i < selected.length; i++) {
      const code = selected[i];
      const meta = allCodesWithMetadata.find(c => c.code === code);
      if (meta) {
        handleDownloadQRCode(code, meta.rowRef);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };

  // High-resolution Print preview window generator
  const handlePrintSelectedQRs = () => {
    if (selected.length === 0) return;
    const printWindow = window.open('', '_blank');

    const labelsHTML = selected.map(code => {
      const meta = allCodesWithMetadata.find(c => c.code === code) || { batch: '-', location: '-', bin: '-', rowRef: {} };
      const payload = getPayloadForCode(code, meta.rowRef);
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(payload)}`;
      return `
        <div class="label-card">
          <!-- Top: Code -->
          <div class="label-code">${code} <span style="font-size: 10px; font-weight: normal; color: #475569;">(${itemCode})</span></div>
          
          <!-- Middle: QR or Barcode -->
          <div class="qr-container">
            <img class="label-qr" src="${qrUrl}" alt="QR" />
          </div>
          
          <div class="barcode-container" style="display: none; padding: 10px 0;">
            <svg class="barcode-svg" data-code="${code}"></svg>
          </div>
          
          <!-- Bottom: Name -->
          <div class="label-title" style="white-space: normal; height: auto; max-height: 40px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${itemName}</div>
          
          <div class="label-footer">
            <div>Batch: ${meta.batch}</div>
            <div>Loc: ${meta.location} / Bin: ${meta.bin}</div>
          </div>
        </div>
      `;
    }).join('');

    printWindow.document.write(`
      <html>
        <head>
          <title>Print QR/Barcode Labels - ${itemName}</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              margin: 20px;
              background: #ffffff;
              color: #000000;
            }
            .no-print {
              margin-bottom: 20px;
              display: flex;
              align-items: center;
              gap: 15px;
              background: #f8fafc;
              padding: 12px 16px;
              border-radius: 8px;
              border: 1px solid #e2e8f0;
            }
            .grid-container {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
              gap: 15px;
            }
            .label-card {
              border: 1px dashed #cccccc;
              padding: 12px;
              text-align: center;
              border-radius: 8px;
              page-break-inside: avoid;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: space-between;
              height: 240px;
              box-sizing: border-box;
            }
            .label-title {
              font-size: 11px;
              font-weight: bold;
              color: #475569;
              text-transform: uppercase;
              width: 100%;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .label-code {
              font-size: 13px;
              font-weight: 700;
              font-family: monospace;
              margin: 4px 0;
              color: #000000;
            }
            .label-qr, .barcode-svg {
              width: 110px;
              height: 110px;
              image-rendering: -moz-crisp-edges !important;
              image-rendering: -webkit-crisp-edges !important;
              image-rendering: pixelated !important;
              image-rendering: crisp-edges !important;
            }
            .barcode-svg {
              max-width: 100%;
              height: 48px;
            }
            .label-footer {
              font-size: 9px;
              color: #64748b;
              width: 100%;
              text-align: left;
              border-top: 1px solid #f1f5f9;
              padding-top: 4px;
              margin-top: 4px;
            }
            @media print {
              .no-print { display: none; }
              body { margin: 0; }
              .grid-container {
                gap: 10px;
              }
              .label-card {
                border: 1px solid #000000;
              }
            }
          </style>
        </head>
        <body>
          <div class="no-print">
            <button onclick="window.print()" style="padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">Print Labels</button>
            <div style="display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 600;">
              <span style="color: #475569;">Format:</span>
              <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <input type="radio" name="label_type" value="qr" checked onchange="toggleFormat('qr')" /> QR Code
              </label>
              <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <input type="radio" name="label_type" value="barcode" onchange="toggleFormat('barcode')" /> Barcode (128)
              </label>
            </div>
            <span style="color: #64748b; font-size: 12px;">(Select Save as PDF or your Label Printer in the print dialog)</span>
          </div>
          <div class="grid-container">
            ${labelsHTML}
          </div>
          <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min"></script>
          <script>
            function initBarcodes() {
              const svgs = document.querySelectorAll('.barcode-svg');
              svgs.forEach(svg => {
                const code = svg.getAttribute('data-code');
                try {
                  JsBarcode(svg, code, {
                    format: "CODE128",
                    width: 1.5,
                    height: 48,
                    displayValue: false,
                    margin: 0
                  });
                } catch (e) {
                  console.error('JsBarcode error:', e);
                }
              });
            }

            function toggleFormat(type) {
              const qrs = document.querySelectorAll('.qr-container');
              const barcodes = document.querySelectorAll('.barcode-container');
              if (type === 'qr') {
                qrs.forEach(el => el.style.display = 'block');
                barcodes.forEach(el => el.style.display = 'none');
              } else {
                qrs.forEach(el => el.style.display = 'none');
                barcodes.forEach(el => el.style.display = 'block');
              }
            }

            window.onload = function() {
              initBarcodes();
              setTimeout(function() {
                window.print();
              }, 600);
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const getGradient = () => {
    if (isAsset) return 'linear-gradient(135deg, #0284c7, #0369a1)';
    if (isConsumable) return 'linear-gradient(135deg, #ea580c, #c2410c)';
    return 'linear-gradient(135deg, #4f46e5, #4338ca)';
  };

  const getTitle = () => {
    if (isAsset) return 'Select Asset Codes';
    if (isConsumable) return 'Select Consumable Codes';
    return 'Select Serial Numbers';
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      width={800}
      destroyOnClose
      centered
      styles={{
        header: { background: '#ffffff', borderBottom: '1px solid #e2e8f0', padding: '16px 24px', borderRadius: '12px 12px 0 0' },
        body: { background: '#f8fafc', padding: '0', maxHeight: '68vh', overflowY: 'auto' },
        footer: { background: '#ffffff', borderTop: '1px solid #e2e8f0', padding: '12px 24px', borderRadius: '0 0 12px 12px' },
        content: { padding: 0, borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)' },
        mask: { backdropFilter: 'blur(3px)' }
      }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '92%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10,
              background: getGradient(),
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <BarcodeOutlined style={{ color: '#fff', fontSize: 18 }} />
            </div>
            <div>
              <div style={{ color: '#0f172a', fontWeight: 800, fontSize: 16 }}>
                {getTitle()}
              </div>
              <div style={{ color: '#64748b', fontSize: 12, fontWeight: 500 }}>
                {itemName} · <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{itemCode}</span>
              </div>
            </div>
          </div>
          {targetQty > 0 && (
            <Tag color="warning" style={{ fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 6, margin: 0 }}>
              Required Qty: {targetQty}
            </Tag>
          )}
        </div>
      }
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button
            type="link"
            danger
            onClick={handleClearAll}
            disabled={selected.length === 0}
            style={{ fontWeight: 600, padding: 0 }}
          >
            Clear Selected ({selected.length})
          </Button>
          <Space size={12}>
            <Button onClick={onCancel} style={{ fontWeight: 600, borderRadius: 6 }}>
              Cancel
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleFilled />}
              onClick={handleSaveClick}
              disabled={targetQty > 0 && selected.length !== targetQty}
              style={{
                background: getGradient(),
                border: 'none',
                fontWeight: 700,
                borderRadius: 6,
                height: 38,
                padding: '0 20px',
                boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)'
              }}
            >
              Apply Selection ({selected.length})
            </Button>
          </Space>
        </div>
      }
    >
      {/* Filters and Controls */}
      <div style={{ padding: '20px 24px', background: '#ffffff', borderBottom: '1px solid #e2e8f0' }}>
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} md={10}>
            <div style={{ fontWeight: 600, color: '#334155', marginBottom: 6, fontSize: 12 }}>Search Code / Location</div>
            <Input
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="Search or scan code..."
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              onPressEnter={e => handleSearchSubmit(e.target.value)}
              style={{ borderRadius: 6 }}
              allowClear
            />
          </Col>
          <Col xs={12} md={7}>
            <div style={{ fontWeight: 600, color: '#334155', marginBottom: 6, fontSize: 12 }}>Filter Batch</div>
            <Select
              style={{ width: '100%' }}
              value={selectedBatchFilter}
              onChange={setSelectedBatchFilter}
              dropdownStyle={{ borderRadius: 6 }}
            >
              <Option value="ALL">All Batches</Option>
              {uniqueBatches.map(b => (
                <Option key={b.id} value={b.id}>{b.name}</Option>
              ))}
            </Select>
          </Col>
          <Col xs={12} md={7}>
            <div style={{ fontWeight: 600, color: '#334155', marginBottom: 6, fontSize: 12 }}>Filter Bin</div>
            <Select
              style={{ width: '100%' }}
              value={selectedBinFilter}
              onChange={setSelectedBinFilter}
              dropdownStyle={{ borderRadius: 6 }}
            >
              <Option value="ALL">All Bins</Option>
              {uniqueBins.map(b => (
                <Option key={b.id} value={b.id}>{b.name}</Option>
              ))}
            </Select>
          </Col>
        </Row>


      </div>

      {scannedQRPayload && (
        <div style={{ margin: '0 24px 16px', padding: '12px 16px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <div style={{ fontWeight: 700, color: '#0369a1', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <QrcodeOutlined style={{ color: '#0284c7' }} /> Scanned Item Details
            </div>
            <Row gutter={[16, 8]} style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>
              <Col xs={12} sm={8}>
                <span style={{ color: '#64748b', display: 'block', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Code</span>
                <strong style={{ fontFamily: 'monospace', fontSize: 13 }}>{scannedQRPayload.code}</strong>
              </Col>
              <Col xs={12} sm={8}>
                <span style={{ color: '#64748b', display: 'block', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Manufacture Date</span>
                <strong>{scannedQRPayload.mfgdate || '-'}</strong>
              </Col>
              {isAsset ? (
                <Col xs={12} sm={8}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Warranty Expiry</span>
                  <Tag color="blue" style={{ fontWeight: 600, margin: 0 }}>{scannedQRPayload.warranty || '-'}</Tag>
                </Col>
              ) : (
                <Col xs={12} sm={8}>
                  <span style={{ color: '#64748b', display: 'block', fontSize: 10, textTransform: 'uppercase', fontWeight: 600 }}>Expiry Date</span>
                  <Tag color="volcano" style={{ fontWeight: 600, margin: 0 }}>{scannedQRPayload.expiry || '-'}</Tag>
                </Col>
              )}
            </Row>
          </Space>
        </div>
      )}

      {/* Paginated Cards Grid */}
      <div style={{ padding: '24px', minHeight: '340px' }}>
        {filteredCodes.length === 0 ? (
          <Empty
            description={
              <div style={{ marginTop: 24 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  No stock items match your search/filter criteria.
                </Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Ensure you've selected correct batches or bins in the issue row.
                </Text>
              </div>
            }
          />
        ) : (
          <>
            <Row gutter={[14, 14]}>
              {paginatedCodes.map((item) => {
                const isChecked = selected.includes(item.code);
                const isLocked = lockedCodes && !!lockedCodes[item.code];
                const lockedByPkg = isLocked ? lockedCodes[item.code] : null;
                const codePayload = getPayloadForCode(item.code, item.rowRef);
                return (
                  <Col xs={24} sm={12} lg={8} key={item.code}>
                    <Card
                      size="small"
                      hoverable={!isLocked}
                      onClick={() => !isLocked && toggleCode(item.code)}
                      styles={{ body: { padding: 12 } }}
                      style={{
                        borderRadius: 10,
                        border: isLocked
                          ? '1px dashed #cbd5e1'
                          : isChecked
                          ? '2px solid #2563eb'
                          : '1px solid #e2e8f0',
                        background: isLocked ? '#f1f5f9' : isChecked ? '#eff6ff' : '#ffffff',
                        opacity: isLocked ? 0.7 : 1,
                        transition: 'all 0.15s ease',
                        cursor: isLocked ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <Checkbox
                          checked={isChecked}
                          disabled={isLocked}
                          onClick={e => e.stopPropagation()}
                          onChange={() => !isLocked && toggleCode(item.code)}
                          style={{ marginTop: 2 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <Text
                              strong
                              style={{
                                fontSize: 13,
                                fontFamily: 'monospace',
                                color: isLocked ? '#64748b' : isChecked ? '#1e3a8a' : '#1e293b',
                                display: 'block',
                                wordBreak: 'break-all',
                              }}
                            >
                              {item.code}
                            </Text>
                            {isLocked && (
                              <Tooltip title={`Locked in ${lockedByPkg}`}>
                                <LockOutlined style={{ color: '#ef4444', fontSize: 13 }} />
                              </Tooltip>
                            )}
                          </div>
                          {(() => {
                            const details = serialDetails && serialDetails[item.code];
                            const mfg = details?.mfg_date || item.rowRef.mfg_date;
                            const exp = details?.expiry_date || item.rowRef.expiry_date;
                            const warranty = details?.warranty_expiry || item.rowRef.warranty_expiry;
                            return (
                              <div style={{ fontSize: 11, color: '#64748b', display: 'flex', flexDirection: 'column', gap: 1 }}>
                                <span>📍 {item.location} (Bin: {item.bin})</span>
                                <span>📦 Batch: <span style={{ fontWeight: 600 }}>{item.batch}</span></span>
                                {mfg && <span>🏭 Mfg: {mfg}</span>}
                                {isAsset && warranty && <span>🛡️ Warranty: <Tag color="blue" style={{ fontSize: 10, paddingInline: 4, height: 16, lineHeight: '14px', margin: 0 }}>{warranty}</Tag></span>}
                                {!isAsset && exp && <span>⌛ Expiry: <Tag color="volcano" style={{ fontSize: 10, paddingInline: 4, height: 16, lineHeight: '14px', margin: 0 }}>{exp}</Tag></span>}
                              </div>
                            );
                          })()}
                        </div>

                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>

            {filteredCodes.length > pageSize && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
                <Pagination
                  current={currentPage}
                  pageSize={pageSize}
                  total={filteredCodes.length}
                  onChange={setCurrentPage}
                  showSizeChanger={false}
                  style={{ background: '#ffffff', padding: '6px 16px', borderRadius: 8, border: '1px solid #e2e8f0' }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

export default AssetCodesTreeModal;
