// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, Select, Button, Space, Spin, Table,
  Descriptions, Row, Col, InputNumber, Typography, Divider, Tag, App,
  Progress, Badge, Radio, Popconfirm, Tooltip
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, PlusOutlined,
  DeleteOutlined, InboxOutlined, EyeOutlined, CheckOutlined, ScanOutlined,
  AimOutlined, EnvironmentOutlined, ClockCircleOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import StatusTag from '../components/StatusTag';
import ItemSelector from '../components/ItemSelector';
import BarcodeScanner from '../components/BarcodeScanner';
import SerialNumbersModal from '../components/SerialNumbersModal';
import api from '../config/api';
import { formatDateTime, formatNumber, getErrorMessage } from '../utils/helpers';

const { Text } = Typography;

const ITEM_STATUSES = {
  pending: { color: '#fa8c16', label: 'Pending' },
  in_progress: { color: '#eb2f96', label: 'In Progress' },
  done: { color: '#52c41a', label: 'Done' },
  skipped: { color: '#8c8c8c', label: 'Skipped' },
};

const PutawayForm = () => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const isNew = !id || id === 'new';

  // State
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [putaway, setPutaway] = useState(null);

  // Lookup data
  const [warehouses, setWarehouses] = useState([]);
  const [grnList, setGrnList] = useState([]);
  const [grnItems, setGrnItems] = useState([]);

  // Items table state
  const [items, setItems] = useState([]);
  const [putawayType, setPutawayType] = useState('grn_based');

  // Cascading location state per item (keyed by item row key)
  const [locationOptions, setLocationOptions] = useState({});
  const [lineOptions, setLineOptions] = useState({});
  const [rackOptions, setRackOptions] = useState({});
  const [binOptions, setBinOptions] = useState({});

  // Execution states (view/execute mode)
  const [scannerActive, setScannerActive] = useState(false);
  const [activeScanItemKey, setActiveScanItemKey] = useState(null);
  const [putawayItems, setPutawayItems] = useState([]);

  // Read query params for pre-population
  const getQueryParam = (key) => {
    const params = new URLSearchParams(location.search);
    return params.get(key);
  };

  // --- Load Warehouses ---
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setWarehouses(list.map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
    } catch {
      // silent
    }
  }, []);

  // --- Load GRN list (ones ready for putaway) ---
  const loadGRNs = useCallback(async () => {
    try {
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 200, status: 'qi_done,putaway_pending,partially_putaway' },
      });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setGrnList(list.map((g) => ({
        label: `${g.grn_number || g.id} - ${g.vendor_name || ''}`,
        value: g.id,
        grn: g,
      })));
      if (list.length === 0) {
        message.info('No GRNs ready for putaway. Complete Quality Inspection first.');
      }
    } catch (e) {
      message.error('Failed to load GRNs. ' + (e?.response?.data?.detail || e?.message || ''));
      try {
        const res = await api.get('/warehouse/grn', { params: { page_size: 200 } });
        const data = res.data;
        const list = data.items || data.data || data || [];
        setGrnList(list.map((g) => ({
          label: `${g.grn_number || g.id} - ${g.vendor_name || ''}`,
          value: g.id,
          grn: g,
        })));
      } catch {
        // silent
      }
    }
  }, [message]);

  // --- Load GRN items when a GRN is selected ---
  const loadGRNItems = useCallback(async (grnId) => {
    if (!grnId) {
      setGrnItems([]);
      return;
    }
    try {
      const res = await api.get(`/warehouse/grn/${grnId}`);
      const data = res.data;
      const grnItemsList = data.items || [];
      setGrnItems(grnItemsList);

      const newItems = grnItemsList.map((gi, idx) => ({
        key: `grn-${gi.id || idx}-${Date.now()}`,
        grn_item_id: gi.id,
        item_id: gi.item_id,
        item_name: gi.item_name || (gi.item && (gi.item.item_name || gi.item.name)) || '',
        item_code: gi.item_code || (gi.item && gi.item.item_code) || '',
        qty: gi.received_qty || gi.qty || gi.quantity || 0,
        uom_id: gi.uom_id,
        uom_name: gi.uom || gi.uom_name || (gi.item && gi.item.uom) || '',
        batch_id: gi.batch_id || null,
        batch_number: gi.batch_number || '',
        suggested_bin_id: null,
        location_id: null,
        line_id: null,
        rack_id: null,
      }));
      setItems(newItems);

      if (data.warehouse_id) {
        form.setFieldsValue({ warehouse_id: data.warehouse_id });
        newItems.forEach((item) => {
          loadLocations(data.warehouse_id, item.key);
        });
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [form, message]);

  // --- Cascading selectors: Load locations for a warehouse ---
  const loadLocations = useCallback(async (warehouseId, itemKey) => {
    if (!warehouseId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/locations`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setLocationOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((l) => ({ label: l.name || l.code || l.label, value: l.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load lines for a location ---
  const loadLines = useCallback(async (warehouseId, locationId, itemKey) => {
    if (!warehouseId || !locationId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/locations/${locationId}/lines`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setLineOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((l) => ({ label: l.name || l.code || l.label, value: l.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load racks for a line ---
  const loadRacks = useCallback(async (warehouseId, lineId, itemKey) => {
    if (!warehouseId || !lineId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/lines/${lineId}/racks`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setRackOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((r) => ({ label: r.name || r.code || r.label, value: r.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load bins for a rack ---
  const loadBins = useCallback(async (warehouseId, rackId, itemKey) => {
    if (!warehouseId || !rackId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/racks/${rackId}/bins`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setBinOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((b) => ({ label: b.name || b.code || b.label, value: b.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Fetch existing putaway ---
  const fetchPutaway = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/putaways/${id}`);
      const data = res.data;
      setPutaway(data);
      setPutawayType(data.putaway_type || 'system_directed');

      const mappedItems = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        qty: item.qty || item.quantity || 0,
        batch_number: item.batch_number || '',
        suggested_bin: item.suggested_bin || '',
        suggested_bin_id: item.suggested_bin_id || null,
        actual_bin: item.actual_bin || item.suggested_bin || '',
        actual_bin_id: item.actual_bin_id || item.suggested_bin_id || null,
        status: item.status || 'pending',
        scanned_at: item.scanned_at || null,
        scan_confirmed: !!item.scanned_at,
        has_serial: item.has_serial || false,
        serial_numbers: item.serial_numbers || [],
      }));
      setPutawayItems(mappedItems);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/putaway');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate, message]);

  useEffect(() => {
    if (isNew) {
      loadWarehouses();
      loadGRNs();
      const grnId = getQueryParam('grn_id');
      if (grnId) {
        form.setFieldsValue({ grn_id: parseInt(grnId, 10) });
        loadGRNItems(parseInt(grnId, 10));
      }
    } else {
      fetchPutaway();
    }
  }, [isNew, fetchPutaway, loadWarehouses, loadGRNs]);

  // --- Update item field ---
  const updateItem = (key, field, value) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };

        if (field === 'location_id') {
          updated.line_id = null;
          updated.rack_id = null;
          updated.suggested_bin_id = null;
          setLineOptions((p) => ({ ...p, [key]: [] }));
          setRackOptions((p) => ({ ...p, [key]: [] }));
          setBinOptions((p) => ({ ...p, [key]: [] }));
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadLines(warehouseId, value, key);
          }
        }
        if (field === 'line_id') {
          updated.rack_id = null;
          updated.suggested_bin_id = null;
          setRackOptions((p) => ({ ...p, [key]: [] }));
          setBinOptions((p) => ({ ...p, [key]: [] }));
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadRacks(warehouseId, value, key);
          }
        }
        if (field === 'rack_id') {
          updated.suggested_bin_id = null;
          setBinOptions((p) => ({ ...p, [key]: [] }));
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadBins(warehouseId, value, key);
          }
        }

        return updated;
      })
    );
  };

  // --- Add a blank item row (manual mode) ---
  const addItemRow = () => {
    const newKey = `manual-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        key: newKey,
        grn_item_id: null,
        item_id: null,
        item_name: '',
        item_code: '',
        qty: 0,
        uom_id: null,
        uom_name: '',
        batch_id: null,
        suggested_bin_id: null,
        location_id: null,
        line_id: null,
        rack_id: null,
      },
    ]);
    const warehouseId = form.getFieldValue('warehouse_id');
    if (warehouseId) {
      loadLocations(warehouseId, newKey);
    }
  };

  // --- Remove an item row ---
  const removeItem = (key) => {
    setItems((prev) => prev.filter((item) => item.key !== key));
  };

  // --- Handle warehouse change ---
  const handleWarehouseChange = (warehouseId) => {
    setLocationOptions({});
    setLineOptions({});
    setRackOptions({});
    setBinOptions({});
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        location_id: null,
        line_id: null,
        rack_id: null,
        suggested_bin_id: null,
      }))
    );
    if (warehouseId) {
      items.forEach((item) => {
        loadLocations(warehouseId, item.key);
      });
    }
  };

  // --- Handle GRN selection ---
  const handleGRNChange = (grnId) => {
    if (grnId) {
      loadGRNItems(grnId);
    } else {
      setGrnItems([]);
      setItems([]);
    }
  };

  // --- Handle putaway type change ---
  const handlePutawayTypeChange = (type) => {
    setPutawayType(type);
    if (type === 'manual') {
      form.setFieldsValue({ grn_id: undefined });
      setGrnItems([]);
      setItems([]);
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (items.length === 0) {
        message.error('Please add at least one item');
        return;
      }
      const invalidItems = items.filter((item) => !item.item_id || !item.qty || item.qty <= 0);
      if (invalidItems.length > 0) {
        message.error('All items must have a valid item selected and quantity greater than 0');
        return;
      }
      setSubmitting(true);

      const payload = {
        grn_id: values.grn_id || null,
        warehouse_id: values.warehouse_id,
        putaway_type: putawayType,
        remarks: values.remarks || null,
        items: items.map((item) => ({
          grn_item_id: item.grn_item_id || null,
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || null,
          suggested_bin_id: item.suggested_bin_id || null,
          batch_id: item.batch_id || null,
        })),
      };

      const res = await api.post('/warehouse/putaways', payload);
      message.success('Putaway created successfully');
      const newId = res.data?.id;
      if (newId) {
        navigate(`/warehouse/putaway/${newId}`);
      } else {
        navigate('/warehouse/putaway');
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Execution Handlers (View Mode) ---
  const updatePutawayItemBin = (key, binValue) => {
    const trimmedValue = typeof binValue === 'string' ? binValue.trim() : binValue;
    const match = typeof trimmedValue === 'string' ? trimmedValue.match(/^bin-(\d+)$/) : null;
    const resolvedValue = match ? parseInt(match[1], 10) : trimmedValue || null;
    setPutawayItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, actual_bin: trimmedValue || '', actual_bin_id: resolvedValue };
      })
    );
  };

  const updatePutawayItemBatch = (key, batchNumber) => {
    setPutawayItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, batch_number: batchNumber };
      })
    );
  };

  const handleScanConfirm = async (itemKey, scanResult) => {
    const item = putawayItems.find((i) => i.key === itemKey);
    if (!item) return;

    const scannedValue = scanResult.value;
    const timestamp = scanResult.timestamp;

    const matchesItem = (
      scannedValue === item.item_code ||
      scannedValue === item.item_name ||
      scannedValue === item.batch_number ||
      scannedValue.includes(item.item_code)
    );

    if (!matchesItem) {
      message.error(`Scanned barcode "${scannedValue}" does not match item "${item.item_code || item.item_name}".`);
      return;
    }

    if (item.has_serial) {
      const needed = parseInt(item.qty || 0, 10);
      const filled = (item.serial_numbers || []).filter(s => s && s.trim()).length;
      if (filled !== needed) {
        message.error(`Item "${item.item_name}" requires ${needed} serial numbers.`);
        return;
      }
    }

    try {
      await api.put(`/warehouse/putaways/${id}/items/${item.id}/confirm`, {
        actual_bin_id: item.actual_bin_id,
        scanned_at: timestamp,
        barcode: scannedValue,
        serial_numbers: item.serial_numbers || [],
      });

      setPutawayItems((prev) =>
        prev.map((i) => {
          if (i.key !== itemKey) return i;
          return { ...i, status: 'done', scanned_at: timestamp, scan_confirmed: true };
        })
      );
      message.success(`Item "${item.item_name}" confirmed at bin`);

      const updatedItems = putawayItems.map((i) =>
        i.key === itemKey ? { ...i, status: 'done' } : i
      );
      const allDone = updatedItems.every((i) => i.status === 'done' || i.status === 'skipped');
      if (allDone) {
        message.success('All items confirmed! Putaway auto-completed.');
        try {
          await api.put(`/warehouse/putaways/${id}/complete`);
          setPutaway((prev) => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : prev);
          fetchPutaway();
        } catch {
          // silent
        }
      }

      setActiveScanItemKey(null);
      setScannerActive(false);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleBatchScan = async (scanResult) => {
    const scannedValue = scanResult.value;
    const timestamp = scanResult.timestamp;

    const matchingItem = putawayItems.find(
      (i) =>
        (i.status === 'pending' || i.status === 'in_progress') &&
        (scannedValue === i.item_code ||
          scannedValue === i.batch_number ||
          scannedValue.includes(i.item_code || ''))
    );

    if (!matchingItem) {
      message.warning(`No pending item found matching barcode: ${scannedValue}`);
      return;
    }

    if (matchingItem.has_serial) {
      const needed = parseInt(matchingItem.qty || 0, 10);
      const filled = (matchingItem.serial_numbers || []).filter(s => s && s.trim()).length;
      if (filled !== needed) {
        message.warning(`Item "${matchingItem.item_name}" requires ${needed} serial numbers.`);
        return;
      }
    }

    try {
      await api.put(`/warehouse/putaways/${id}/items/${matchingItem.id}/confirm`, {
        actual_bin_id: matchingItem.actual_bin_id,
        scanned_at: timestamp,
        barcode: scannedValue,
        serial_numbers: matchingItem.serial_numbers || [],
      });

      setPutawayItems((prev) => {
        const updated = prev.map((i) => {
          if (i.key !== matchingItem.key) return i;
          return { ...i, status: 'done', scanned_at: timestamp, scan_confirmed: true };
        });

        const allDone = updated.every((i) => i.status === 'done' || i.status === 'skipped');
        if (allDone) {
          message.success('All items confirmed! Putaway auto-completed.');
          api.put(`/warehouse/putaways/${id}/complete`).then(() => {
            setPutaway((prev) => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : prev);
            fetchPutaway();
          }).catch(() => {});
        }

        return updated;
      });

      message.success(`Confirmed: ${matchingItem.item_name}`);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSkipItem = async (itemKey) => {
    const item = putawayItems.find((i) => i.key === itemKey);
    if (!item) return;
    try {
      await api.put(`/warehouse/putaways/${id}/items/${item.id}/skip`);
      setPutawayItems((prev) =>
        prev.map((i) => {
          if (i.key !== itemKey) return i;
          return { ...i, status: 'skipped' };
        })
      );
      message.info(`Item "${item.item_name}" skipped`);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleStartPutaway = async () => {
    if (!putaway) return;
    try {
      await api.put(`/warehouse/putaways/${id}/start`);
      setPutaway((prev) => prev ? { ...prev, status: 'in_progress', started_at: new Date().toISOString() } : prev);
      setPutawayItems((prev) => prev.map((i) => i.status === 'pending' ? { ...i, status: 'in_progress' } : i));
      message.success('Putaway started');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handlePutawayTypeChangeView = async (type) => {
    if (!putaway) return;
    setPutawayType(type);
    try {
      await api.put(`/warehouse/putaways/${id}`, { putaway_type: type });
      if (type === 'system_directed') {
        const res = await api.get(`/warehouse/putaways/${id}`);
        const data = res.data;
        const mapped = (data.items || []).map((item, idx) => ({
          key: item.id || Date.now() + idx,
          id: item.id,
          item_id: item.item_id,
          item_name: item.item_name || '',
          item_code: item.item_code || '',
          qty: item.qty || item.quantity || 0,
          batch_number: item.batch_number || '',
          suggested_bin: item.suggested_bin || '',
          suggested_bin_id: item.suggested_bin_id || null,
          actual_bin: item.actual_bin || item.suggested_bin || '',
          actual_bin_id: item.actual_bin_id || item.suggested_bin_id || null,
          status: item.status || 'pending',
          scanned_at: item.scanned_at || null,
          scan_confirmed: !!item.scanned_at,
          has_serial: item.has_serial || false,
          serial_numbers: item.serial_numbers || [],
        }));
        setPutawayItems(mapped);
        message.success('Bins re-suggested by system based on availability');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSaveBinAssignments = async () => {
    if (!putaway) return;
    setSubmitting(true);
    try {
      await api.put(`/warehouse/putaways/${id}/bins`, {
        items: putawayItems.map((item) => ({
          id: item.id,
          actual_bin_id: item.actual_bin_id,
          actual_bin: item.actual_bin,
          batch_number: item.batch_number,
        })),
      });
      message.success('Bin assignments and batch numbers saved');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const getProgress = () => {
    if (putawayItems.length === 0) return 0;
    const done = putawayItems.filter((i) => i.status === 'done' || i.status === 'skipped').length;
    return Math.round((done / putawayItems.length) * 100);
  };

  const putawayItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_name', width: 180, ellipsis: true,
      render: (v, r) => (
        <Tooltip title={`${r.item_code || ''} - ${v}`}>
          <Text ellipsis style={{ maxWidth: 160 }}>{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 70, align: 'center',
      render: (v) => <Text strong>{formatNumber(v)}</Text>,
    },
    {
      title: 'Batch', dataIndex: 'batch_number', width: 150,
      render: (v, record) => {
        if (record.status === 'done' || record.status === 'skipped') {
          return <Tag color="blue">{v || '-'}</Tag>;
        }
        return (
          <Input
            size="small"
            placeholder="Enter batch #"
            value={record.batch_number || ''}
            onChange={(e) => updatePutawayItemBatch(record.key, e.target.value)}
            disabled={record.status === 'done' || record.status === 'skipped'}
            style={{ width: '100%' }}
          />
        );
      },
    },
    {
      title: 'Suggested Bin', dataIndex: 'suggested_bin', width: 150,
      render: (v) => v ? (
        <Tag icon={<AimOutlined />} color="blue">{v}</Tag>
      ) : (
        <Text type="secondary">Not assigned</Text>
      ),
    },
    {
      title: 'Actual Bin', dataIndex: 'actual_bin', width: 200,
      render: (val, record) => {
        if (record.scan_confirmed || record.status === 'done') {
          return <Tag icon={<EnvironmentOutlined />} color="green">{val || record.suggested_bin || '-'}</Tag>;
        }
        return (
          <Input
            size="small"
            prefix={<EnvironmentOutlined />}
            placeholder="Enter bin..."
            value={record.actual_bin || ''}
            disabled={record.status === 'done' || record.status === 'skipped'}
            onChange={(e) => updatePutawayItemBin(record.key, e.target.value)}
            style={{ width: '100%', textAlign: 'left' }}
          />
        );
      },
    },
    {
      title: 'Status', dataIndex: 'status', width: 110,
      render: (v) => {
        const cfg = ITEM_STATUSES[v] || ITEM_STATUSES.pending;
        return (
          <Tag style={{ color: '#fff', backgroundColor: cfg.color, borderColor: cfg.color }}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      title: 'Scanned At', dataIndex: 'scanned_at', width: 140,
      render: (v) => v ? (
        <Text style={{ fontSize: 12 }}>{formatDateTime(v)}</Text>
      ) : '-',
    },
    {
      title: 'Serial Numbers',
      width: 150,
      render: (_, record) => {
        const isReadOnly = record.status === 'done' || record.status === 'skipped';
        return (
          <SerialNumbersModal
            value={record.serial_numbers || []}
            onChange={(updated) => {
              setPutawayItems((prev) =>
                prev.map((item) =>
                  item.key === record.key ? { ...item, serial_numbers: updated } : item
                )
              );
            }}
            itemName={record.item_name}
            itemCode={record.item_code}
            quantity={parseInt(record.qty || 0, 10)}
            hasSerial={record.has_serial}
            readOnly={isReadOnly}
            size="small"
          />
        );
      },
    },
    {
      title: 'Actions', width: 180,
      render: (_, record) => {
        if (record.status === 'done') {
          return <Tag color="success" icon={<CheckOutlined />}>Confirmed</Tag>;
        }
        if (record.status === 'skipped') {
          return <Tag color="default">Skipped</Tag>;
        }
        return (
          <Space size="small">
            <Tooltip title={record.actual_bin_id ? 'Mark as placed in the selected bin' : 'Pick a bin first'}>
              <Popconfirm
                title="Confirm putaway of this item?"
                onConfirm={async () => {
                  if (!record.actual_bin_id) {
                    message.warning('Pick a bin in "Actual Bin" before confirming.');
                    return;
                  }
                  if (record.has_serial) {
                    const needed = parseInt(record.qty || 0, 10);
                    const filled = (record.serial_numbers || []).filter(s => s && s.trim()).length;
                    if (filled !== needed) {
                      message.warning(`Please enter all ${needed} serial numbers before confirming.`);
                      return;
                    }
                  }
                  try {
                    await api.put(`/warehouse/putaways/${id}/items/${record.id}/confirm`, {
                      actual_bin_id: record.actual_bin_id,
                      scanned_at: new Date().toISOString(),
                      serial_numbers: record.serial_numbers || [],
                    });
                    setPutawayItems((prev) =>
                      prev.map((i) => i.key === record.key
                        ? { ...i, status: 'done', scan_confirmed: true }
                        : i)
                    );
                    message.success(`Confirmed: ${record.item_name}`);
                  } catch (err) {
                    message.error(getErrorMessage(err));
                  }
                }}
                disabled={!record.actual_bin_id}
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<CheckOutlined />}
                  disabled={!record.actual_bin_id}
                >
                  Confirm
                </Button>
              </Popconfirm>
            </Tooltip>
            <Tooltip title="Scan to Confirm (optional)">
              <Button
                size="small"
                icon={<ScanOutlined />}
                onClick={() => {
                  setActiveScanItemKey(record.key);
                  setScannerActive(true);
                }}
              >
                Scan
              </Button>
            </Tooltip>
            <Popconfirm title="Skip this item?" onConfirm={() => handleSkipItem(record.key)}>
              <Button size="small" type="text" danger>Skip</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  // --- VIEW MODE (existing putaway) ---
  if (!isNew && putaway) {
    return (
      <div>
        <PageHeader
          title={putaway.putaway_number || `Putaway #${id}`}
          subtitle="Putaway Detail"
        >
          <Space>
            {(putaway.status === 'draft' || putaway.status === 'pending') && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={handleStartPutaway}
              >
                Start Putaway
              </Button>
            )}
            {((putaway.status === 'draft' || putaway.status === 'pending') || putaway.status === 'in_progress') && (
              <Button onClick={handleSaveBinAssignments} loading={submitting}>
                Save Bin Assignments
              </Button>
            )}
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/warehouse/putaway')}
            >
              Back
            </Button>
          </Space>
        </PageHeader>

        {/* Header Info */}
        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Putaway Number">{putaway.putaway_number}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={putaway.status} /></Descriptions.Item>
            <Descriptions.Item label="GRN Reference">{putaway.grn_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{putaway.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Assigned To">{putaway.assigned_to_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Putaway Type">
              <Tag color={putaway.putaway_type === 'system_directed' ? 'blue' : 'orange'}>
                {putaway.putaway_type === 'system_directed' ? 'System Directed' : 'Manual'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Started At">
              {putaway.started_at ? formatDateTime(putaway.started_at) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Completed At">
              {putaway.completed_at ? formatDateTime(putaway.completed_at) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Created">
              {formatDateTime(putaway.created_at)}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        {/* Progress Bar */}
        <Card size="small" style={{ marginBottom: 16 }}>
          <Row align="middle" gutter={16}>
            <Col span={4}>
              <Text strong>Progress:</Text>
            </Col>
            <Col span={14}>
              <Progress
                percent={getProgress()}
                status={getProgress() === 100 ? 'success' : 'active'}
                strokeColor={{
                  '0%': '#eb2f96',
                  '100%': '#52c41a',
                }}
              />
            </Col>
            <Col span={6} style={{ textAlign: 'right' }}>
              <Space>
                <Badge status="success" text={`Done: ${putawayItems.filter((i) => i.status === 'done').length}`} />
                <Badge status="processing" text={`Pending: ${putawayItems.filter((i) => i.status === 'pending' || i.status === 'in_progress').length}`} />
              </Space>
            </Col>
          </Row>
        </Card>

        {/* Putaway Type Toggle */}
        {((putaway.status === 'draft' || putaway.status === 'pending') || putaway.status === 'in_progress') && (
          <Card size="small" style={{ marginBottom: 16 }}>
            <Text strong style={{ marginRight: 12 }}>Putaway Type:</Text>
            <Radio.Group
              value={putawayType}
              onChange={(e) => handlePutawayTypeChangeView(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="system_directed">
                <AimOutlined /> System Directed
              </Radio.Button>
              <Radio.Button value="manual">
                <EnvironmentOutlined /> Manual
              </Radio.Button>
            </Radio.Group>
            {putawayType === 'system_directed' && (
              <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                Bins auto-suggested based on availability
              </Text>
            )}
          </Card>
        )}

        {/* Batch Barcode Scanner */}
        {(putaway.status === 'in_progress') && !activeScanItemKey && (
          <div style={{ marginBottom: 16 }}>
            <Button
              icon={<ScanOutlined />}
              onClick={() => setScannerActive(!scannerActive)}
              type={scannerActive ? 'primary' : 'default'}
              style={{ marginBottom: 8 }}
            >
              {scannerActive ? 'Hide Batch Scanner' : 'Batch Scan Mode'}
            </Button>
            {scannerActive && (
              <Card size="small" style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                <BarcodeScanner
                  onScan={handleBatchScan}
                  placeholder="Scan item barcodes to confirm putaway..."
                  autoFocus
                />
              </Card>
            )}
          </div>
        )}

        {/* Per-item scanner */}
        {activeScanItemKey && (
          <Card
            size="small"
            style={{ marginBottom: 16, background: '#e6f7ff', border: '1px solid #91d5ff' }}
            title={
              <Space>
                <ScanOutlined />
                <Text strong>
                  Scanning for: {putawayItems.find((i) => i.key === activeScanItemKey)?.item_name || 'Item'}
                </Text>
              </Space>
            }
            extra={
              <Button size="small" onClick={() => { setActiveScanItemKey(null); setScannerActive(false); }}>
                Cancel
              </Button>
            }
          >
            <BarcodeScanner
              onScan={(scanResult) => handleScanConfirm(activeScanItemKey, scanResult)}
              placeholder="Scan item barcode to confirm..."
              autoFocus
            />
          </Card>
        )}

        {/* Items Table */}
        <Card>
          <Divider orientation="left">
            <Space>
              <InboxOutlined />
              Putaway Items
              <Badge count={putawayItems.length} style={{ backgroundColor: '#eb2f96' }} />
            </Space>
          </Divider>
          <Table
            dataSource={putawayItems}
            columns={putawayItemColumns}
            rowKey="key"
            pagination={false}
            size="small"
            scroll={{ x: 1350 }}
            rowClassName={(record) => {
              if (record.status === 'done') return 'row-done';
              if (record.status === 'skipped') return 'row-skipped';
              return '';
            }}
          />
        </Card>
      </div>
    );
  }

  // --- CREATE MODE ---
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (_, record) => {
        if (record.grn_item_id) {
          // From GRN - show read-only
          return (
            <Text>
              {record.item_code ? `[${record.item_code}] ` : ''}{record.item_name}
            </Text>
          );
        }
        return (
          <ItemSelector
            value={record.item_id}
            onChange={(val, itemData) => {
              updateItem(record.key, 'item_id', val);
              if (itemData) {
                updateItem(record.key, 'item_name', itemData.item_name || itemData.name || '');
                updateItem(record.key, 'item_code', itemData.item_code || itemData.code || '');
                updateItem(record.key, 'uom_id', itemData.uom_id || null);
                updateItem(record.key, 'uom_name', itemData.uom || itemData.uom_name || '');
              }
            }}
            placeholder="Search item..."
          />
        );
      },
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 100,
      render: (val, record) => (
        <InputNumber
          value={val}
          min={0.01}
          precision={2}
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'qty', v)}
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_name',
      width: 80,
      render: (v) => v || '-',
    },
    {
      title: 'Location',
      width: 150,
      render: (_, record) => (
        <Select
          value={record.location_id}
          options={locationOptions[record.key] || []}
          placeholder="Location"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'location_id', v)}
          onOpenChange={(open) => {
            if (open && !(locationOptions[record.key] || []).length) {
              const warehouseId = form.getFieldValue('warehouse_id');
              if (warehouseId) loadLocations(warehouseId, record.key);
            }
          }}
        />
      ),
    },
    {
      title: 'Line',
      width: 140,
      render: (_, record) => (
        <Select
          value={record.line_id}
          options={lineOptions[record.key] || []}
          placeholder="Line"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'line_id', v)}
          disabled={!record.location_id}
        />
      ),
    },
    {
      title: 'Rack',
      width: 140,
      render: (_, record) => (
        <Select
          value={record.rack_id}
          options={rackOptions[record.key] || []}
          placeholder="Rack"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'rack_id', v)}
          disabled={!record.line_id}
        />
      ),
    },
    {
      title: 'Bin',
      width: 150,
      render: (_, record) => (
        <Input
          value={record.suggested_bin_id || ''}
          placeholder="Enter bin..."
          style={{ width: '100%' }}
          onChange={(e) => updateItem(record.key, 'suggested_bin_id', e.target.value)}
        />
      ),
    },
    {
      title: '',
      width: 50,
      render: (_, record) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeItem(record.key)}
          size="small"
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Create Putaway" subtitle="Create a new putaway order to assign items to bin locations">
        <Space>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/warehouse/putaway')}
          >
            Back
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
        >
          <Row gutter={24}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                label="Putaway Type"
                required
              >
                <Select
                  value={putawayType}
                  onChange={handlePutawayTypeChange}
                  options={[
                    { label: 'GRN Based', value: 'grn_based' },
                    { label: 'Manual', value: 'manual' },
                  ]}
                />
              </Form.Item>
            </Col>
            {putawayType === 'grn_based' && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item
                  name="grn_id"
                  label="GRN"
                  rules={[{ required: putawayType === 'grn_based', message: 'Please select a GRN' }]}
                >
                  <Select
                     options={grnList}
                     placeholder="Select GRN"
                     showSearch
                     optionFilterProp="label"
                     allowClear
                     onChange={handleGRNChange}
                  />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="warehouse_id"
                label="Warehouse"
                rules={[{ required: true, message: 'Please select a warehouse' }]}
              >
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                  onChange={handleWarehouseChange}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="remarks" label="Remarks">
                <Input.TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* Items Table */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid #f0f0f0', paddingBottom: 12 }}>
          <Space style={{ fontSize: 16, fontWeight: 600 }}>
            <InboxOutlined />
            Items ({items.length})
          </Space>
          {putawayType === 'manual' && (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={addItemRow}
            >
              Add Item
            </Button>
          )}
        </div>

        <Table
          dataSource={items}
          columns={itemColumns}
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: putawayType === 'grn_based' ? 'Select a GRN to load items' : 'Click "Add Item" to add items' }}
        />

        <div style={{ marginTop: 24 }}>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={handleSubmit}
              loading={submitting}
              size="large"
              disabled={items.length === 0}
            >
              Create Putaway
            </Button>
            <Button onClick={() => navigate('/warehouse/putaway')}>
              Cancel
            </Button>
          </Space>
        </div>
      </Card>
    </div>
  );
};

export default PutawayForm;
